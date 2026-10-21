import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlane, ControlPlaneError, openStaging } from "../services/src/index.ts";

const ASSISTANT = { voiceId: "voice-life" };

function plane(options: { now?: () => number; store?: ReturnType<typeof openStaging>; code?: () => string } = {}) {
  let refs = 0;
  let tokens = 0;
  let codes = 0;
  return new ControlPlane({
    now: options.now ?? (() => 1_700_000_000_000),
    code: options.code ?? (() => {
      codes += 1;
      return String(100000 + codes).slice(0, 6);
    }),
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
    token: () => {
      tokens += 1;
      return `ctok_${tokens}`;
    },
    ...(options.store ? { store: options.store } : {}),
  });
}

function claimBind(control: ControlPlane, deviceId = "dev-life"): string {
  const ticket = control.issueClaim(deviceId);
  control.redeemClaim(deviceId, ticket.code);
  control.bind({ deviceId, digitalHumanId: "dh-life", assistant: ASSISTANT });
  return ticket.code;
}

test("proof issue one-shot consumes claim code; same code cannot re-issue", () => {
  const control = plane();
  const code = claimBind(control);
  assert.equal(control.claimStatus("dev-life"), "claimed");
  const first = control.issueConnectionCredentialWithProof("dev-life", code);
  assert.equal(first.token, "ctok_1");
  assert.equal(control.claimStatus("dev-life"), "claimed");
  assert.throws(
    () => control.issueConnectionCredentialWithProof("dev-life", code),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "device_proof",
  );
  assert.equal(control.activeCredentialCount("dev-life"), 1);
  const fresh = control.issueClaim("dev-life").code;
  control.redeemClaim("dev-life", fresh);
  const second = control.issueConnectionCredentialWithProof("dev-life", fresh);
  assert.equal(second.token, "ctok_2");
  assert.throws(
    () => control.issueConnectionCredentialWithProof("dev-life", fresh),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "device_proof",
  );
});

test("expired claim/proof code is rejected on credential issue", () => {
  let now = 1_700_000_000_000;
  const control = plane({ now: () => now, code: () => "654321" });
  const ticket = control.issueClaim("dev-exp");
  control.redeemClaim("dev-exp", ticket.code);
  control.bind({ deviceId: "dev-exp", digitalHumanId: "dh-exp", assistant: ASSISTANT });
  now = ticket.expiresAtMs;
  assert.throws(
    () => control.issueConnectionCredentialWithProof("dev-exp", ticket.code),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "claim_expired",
  );
  assert.equal(control.activeCredentialCount("dev-exp"), 0);
  // Wrong code still device_proof (not expired) when status/code mismatch after time travel on a new claim.
  now = 1_700_000_000_000;
  const next = control.issueClaim("dev-exp");
  control.redeemClaim("dev-exp", next.code);
  now = next.expiresAtMs + 1;
  assert.throws(
    () => control.issueConnectionCredentialWithProof("dev-exp", next.code),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "claim_expired",
  );
});

test("consumed proof persists across StagingDb reopen and still blocks re-issue", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-pair-life-"));
  const path = join(dir, "life.json");
  const firstStore = openStaging(path);
  const first = plane({ store: firstStore, code: () => "111222" });
  const code = claimBind(first);
  assert.equal(first.issueConnectionCredentialWithProof("dev-life", code).token, "ctok_1");
  firstStore.close();

  const second = plane({ store: openStaging(path), code: () => "111222" });
  assert.equal(second.claimStatus("dev-life"), "claimed");
  assert.throws(
    () => second.issueConnectionCredentialWithProof("dev-life", code),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "device_proof",
  );
  assert.equal(second.activeCredentialCount("dev-life"), 1);
});

test("in-process issueConnectionCredential still works without consuming claim proof", () => {
  const control = plane({ code: () => "333444" });
  const code = claimBind(control);
  const a = control.issueConnectionCredential("dev-life");
  const b = control.issueConnectionCredential("dev-life");
  assert.equal(a.token, "ctok_1");
  assert.equal(b.token, "ctok_2");
  // Proof path still available until HTTP proof consume.
  const viaProof = control.issueConnectionCredentialWithProof("dev-life", code);
  assert.equal(viaProof.token, "ctok_3");
  assert.throws(
    () => control.issueConnectionCredentialWithProof("dev-life", code),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "device_proof",
  );
});
