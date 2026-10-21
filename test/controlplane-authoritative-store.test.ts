import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ControlPlane,
  ControlPlaneError,
  MemoryStagingDb,
  SqliteStagingDb,
  StagingConflictError,
  type StagingDb,
} from "../services/src/index.ts";

const ASSISTANT = { voiceId: "v", nested: { style: "calm" } };
const NOW = 1_700_000_000_000;

/** Staging db that lets a peer write win immediately before a CAS set. */
class PeerWriteBeforeCasDb implements StagingDb {
  private readonly inner = new MemoryStagingDb();
  peerWriteBeforeCas = false;

  get(section: string): unknown {
    return this.inner.get(section);
  }

  revision(section: string): number {
    return this.inner.revision(section);
  }

  set(section: string, value: unknown, expectedRevision?: number): void {
    if (this.peerWriteBeforeCas && expectedRevision !== undefined) {
      this.peerWriteBeforeCas = false;
      const current = this.inner.get(section);
      if (current !== undefined) {
        this.inner.set(section, current);
      }
    }
    this.inner.set(section, value, expectedRevision);
  }

  close(): void {
    this.inner.close();
  }
}

function boundPair(path: string): {
  writer: ControlPlane;
  reader: ControlPlane;
  writerDb: SqliteStagingDb;
  readerDb: SqliteStagingDb;
} {
  const writerDb = new SqliteStagingDb(path);
  const readerDb = new SqliteStagingDb(path);
  let refs = 0;
  let tokens = 0;
  const shared = {
    now: () => NOW,
    code: () => "042315",
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
    token: () => {
      tokens += 1;
      return `ctok_${tokens}`;
    },
  };
  const writer = new ControlPlane({ store: writerDb, ...shared });
  writer.redeemClaim("dev-1", writer.issueClaim("dev-1").code);
  writer.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant: ASSISTANT });
  const reader = new ControlPlane({ store: readerDb, ...shared });
  return { writer, reader, writerDb, readerDb };
}

test("dual-instance sqlite: writer revoke makes reader assess reject the old token", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-auth-store-"));
  const path = join(dir, "plane.sqlite");
  const { writer, reader, writerDb, readerDb } = boundPair(path);
  try {
    const issued = writer.issueConnectionCredential("dev-1");
    assert.equal(reader.assessConnectionCredential("dev-1", issued.token).ok, true);
    writer.revoke("dev-1");
    const after = reader.assessConnectionCredential("dev-1", issued.token);
    assert.equal(after.ok, false);
    if (!after.ok) {
      assert.equal(after.code, "credential_revoked");
    }
    assert.equal(reader.isRevoked("dev-1"), true);
  } finally {
    writerDb.close();
    readerDb.close();
  }
});

test("dual-instance sqlite: writer rebind makes reader treat old credential as stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-auth-rebind-"));
  const path = join(dir, "plane.sqlite");
  const { writer, reader, writerDb, readerDb } = boundPair(path);
  try {
    const issued = writer.issueConnectionCredential("dev-1");
    assert.equal(reader.assessConnectionCredential("dev-1", issued.token).ok, true);
    const rebound = writer.rebind("dev-1", {
      digitalHumanId: "dh-2",
      assistant: { name: "B", visible: { speech: "hello-b" } },
    });
    assert.equal(rebound.bindingVersion, 2);
    const after = reader.assessConnectionCredential("dev-1", issued.token);
    assert.equal(after.ok, false);
    if (!after.ok) {
      assert.equal(after.code, "credential_missing");
    }
    assert.equal(reader.getBinding("dev-1")?.bindingVersion, 2);
    assert.equal(reader.getBinding("dev-1")?.authorizationRef, rebound.authorizationRef);
  } finally {
    writerDb.close();
    readerDb.close();
  }
});

test("issue then new ControlPlane on same sqlite sees revoke", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-auth-reopen-"));
  const path = join(dir, "plane.sqlite");
  const firstDb = new SqliteStagingDb(path);
  let tokens = 0;
  const first = new ControlPlane({
    store: firstDb,
    now: () => NOW,
    code: () => "042315",
    authorizationRef: () => "aref_1",
    token: () => {
      tokens += 1;
      return `ctok_${tokens}`;
    },
  });
  first.redeemClaim("dev-1", first.issueClaim("dev-1").code);
  first.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant: ASSISTANT });
  const issued = first.issueConnectionCredential("dev-1");
  first.revoke("dev-1");
  firstDb.close();

  const secondDb = new SqliteStagingDb(path);
  try {
    const second = new ControlPlane({ store: secondDb, now: () => NOW });
    const decision = second.assessConnectionCredential("dev-1", issued.token);
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.code, "credential_revoked");
    }
    assert.equal(second.isRevoked("dev-1"), true);
    assert.equal(second.activeCredentialCount("dev-1"), 0);
  } finally {
    secondDb.close();
  }
});

test("optimistic concurrency rejects a stale full-section write", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-auth-cas-"));
  const path = join(dir, "plane.sqlite");
  const leftDb = new SqliteStagingDb(path);
  const rightDb = new SqliteStagingDb(path);
  try {
    const empty = {
      version: 1,
      claims: [],
      bindings: [],
      ota: [],
      credentials: [],
      revoked: [],
      pairChallenges: [],
      devicePrincipals: [],
      grantBound: [],
    };
    leftDb.set("control", empty, 0);
    assert.equal(leftDb.revision("control"), 1);
    assert.equal(rightDb.revision("control"), 1);
    assert.throws(
      () =>
        rightDb.set(
          "control",
          { ...empty, revoked: [{ deviceId: "dev-x", revokedAtMs: NOW }] },
          0,
        ),
      (error: unknown) =>
        error instanceof StagingConflictError && error.expectedRevision === 0 && error.actualRevision === 1,
    );
    leftDb.set("control", { ...empty, revoked: [{ deviceId: "dev-y", revokedAtMs: NOW }] }, 1);
    assert.equal(rightDb.revision("control"), 2);
  } finally {
    leftDb.close();
    rightDb.close();
  }
});

test("ControlPlane maps staging CAS failure to state_conflict", () => {
  const store = new PeerWriteBeforeCasDb();
  const plane = new ControlPlane({
    store,
    now: () => NOW,
    code: () => "042315",
    authorizationRef: () => "aref_1",
  });
  plane.redeemClaim("dev-1", plane.issueClaim("dev-1").code);
  store.peerWriteBeforeCas = true;
  assert.throws(
    () => plane.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant: ASSISTANT }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "state_conflict",
  );
});
