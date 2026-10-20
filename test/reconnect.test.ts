import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assistantEqual } from "../contracts/src/index.ts";
import { ControlPlane, ControlPlaneError, OtaDisabledError, SqliteStagingDb } from "../services/src/index.ts";

const ASSISTANT = { voiceId: "v", nested: { style: "calm" } };

test("refresh is a local stub, revoke clears tokens, and late camera stays rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-reconnect-"));
  const path = join(dir, "plane.sqlite");
  let now = 1_000_000;
  let tokens = 0;
  let refreshedToken = "";
  const db = new SqliteStagingDb(path);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("network");
  };
  try {
    const plane = new ControlPlane({
      store: db,
      now: () => now,
      code: () => "042315",
      authorizationRef: () => "aref_1",
      token: () => {
        tokens += 1;
        return `ctok_${tokens}`;
      },
      credentialTtlMs: 1_000,
    });
    plane.redeemClaim("dev-1", plane.issueClaim("dev-1").code);
    plane.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant: ASSISTANT });
    assert.throws(
      () => plane.issueConnectionCredential("missing"),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_unbound",
    );
    const issued = plane.issueConnectionCredential("dev-1");
    now += 1_000;
    assert.throws(
      () =>
        plane.submitCameraResult({
          deviceId: "dev-1",
          token: issued.token,
          capturedAtMs: now - 10,
          frameBytes: 10,
        }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_expired",
    );
    const refreshed = plane.refreshConnectionCredential("dev-1", issued.token);
    refreshedToken = refreshed.token;
    assert.notEqual(refreshed.token, issued.token);
    assert.equal(fetchCalls, 0);
    assert.equal(plane.getConnectionCredential(issued.token), undefined);
    const accepted = plane.submitCameraResult({
      deviceId: "dev-1",
      token: refreshed.token,
      capturedAtMs: now - 20,
      frameBytes: 10,
    });
    assert.equal(accepted.storedImage, false);
    assert.equal(accepted.accepted, true);
    const cleared = plane.revoke("dev-1");
    assert.equal(cleared.clearedTokens, 1);
    assert.equal(plane.activeCredentialCount("dev-1"), 0);
    assert.equal(plane.isRevoked("dev-1"), true);
    assert.equal(assistantEqual(plane.getBinding("dev-1")?.assistant ?? {}, ASSISTANT), true);
    assert.throws(
      () =>
        plane.submitCameraResult({
          deviceId: "dev-1",
          token: refreshed.token,
          capturedAtMs: now - 100,
          frameBytes: 10,
        }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "camera_revoked",
    );
    assert.throws(
      () => plane.refreshConnectionCredential("dev-1", refreshed.token),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_revoked",
    );
    assert.throws(
      () => plane.issueConnectionCredential("dev-1"),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_revoked",
    );
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }

  const reloaded = new SqliteStagingDb(path);
  try {
    const plane = new ControlPlane({ store: reloaded, now: () => now, authorizationRef: () => "aref_2" });
    assert.equal(plane.isRevoked("dev-1"), true);
    assert.equal(plane.activeCredentialCount("dev-1"), 0);
    assert.equal(assistantEqual(plane.getBinding("dev-1")?.assistant ?? {}, ASSISTANT), true);
    assert.throws(
      () =>
        plane.submitCameraResult({
          deviceId: "dev-1",
          token: refreshedToken,
          capturedAtMs: now - 100,
          frameBytes: 8,
        }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "camera_revoked",
    );
    const rebound = plane.rebind("dev-1");
    assert.equal(rebound.bindingVersion, 2);
    assert.equal(rebound.authorizationRef, "aref_2");
    assert.equal(assistantEqual(rebound.assistant, ASSISTANT), true);
    assert.equal(plane.isRevoked("dev-1"), false);
    assert.throws(
      () =>
        plane.submitCameraResult({
          deviceId: "dev-1",
          token: refreshedToken,
          capturedAtMs: now,
          frameBytes: 8,
        }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_missing",
    );
    const fresh = plane.issueConnectionCredential("dev-1");
    const accepted = plane.submitCameraResult({
      deviceId: "dev-1",
      token: fresh.token,
      capturedAtMs: now,
      frameBytes: 8,
    });
    assert.equal(accepted.storedImage, false);
    assert.throws(() => plane.flash(), OtaDisabledError);
    assert.throws(() => plane.massFlash(), OtaDisabledError);
    assert.throws(
      () =>
        plane.proposeLabOta({
          deviceId: "dev-1",
          version: "1",
          firmwareUrl: "https://api.tenclass.net/xiaozhi/ota/fw.bin",
        }),
      (error: unknown) => error instanceof OtaDisabledError && error.code === "production_ota",
    );
  } finally {
    reloaded.close();
  }
});
