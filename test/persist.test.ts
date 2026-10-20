import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assistantEqual } from "../contracts/src/index.ts";
import { ControlPlane, ControlPlaneError, MemoryStagingDb, OtaDisabledError, openStaging, type StagingDb } from "../services/src/index.ts";

const NOW = 1_700_000_000_000;
const ASSISTANT = { voiceId: "v", nested: { style: "calm" } };

function exercise(open: () => StagingDb): void {
  const first = open();
  try {
    const plane = new ControlPlane({
      store: first,
      now: () => NOW,
      code: () => "042315",
      authorizationRef: () => "aref_1",
    });
    plane.redeemClaim("dev-1", plane.issueClaim("dev-1").code);
  } finally {
    first.close();
  }

  const second = open();
  try {
    const plane = new ControlPlane({
      store: second,
      now: () => NOW,
      authorizationRef: () => "aref_1",
    });
    const binding = plane.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant: ASSISTANT });
    plane.proposeLabOta({ deviceId: "dev-1", version: "lab-0" });
    assert.equal(binding.bindingVersion, 1);
    assert.equal(binding.authorizationRef, "aref_1");
  } finally {
    second.close();
  }

  const third = open();
  try {
    const plane = new ControlPlane({ store: third, now: () => NOW });
    const binding = plane.getBinding("dev-1");
    const ota = plane.getLabOta("dev-1");
    assert.equal(binding?.deviceId, "dev-1");
    assert.equal(assistantEqual(binding?.assistant ?? {}, ASSISTANT), true);
    assert.equal(ota?.firmwareUrl, null);
    assert.equal(ota?.executable, false);
    assert.equal(ota?.force, 0);
    assert.throws(() => plane.flash(), OtaDisabledError);
    assert.throws(() => plane.massFlash(), OtaDisabledError);
  } finally {
    third.close();
  }
}

test("file and sqlite staging survive a new control plane", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-state-"));
  exercise(() => openStaging(join(dir, "plane.json")));
  exercise(() => openStaging(join(dir, "plane.sqlite")));
});

test("memory staging reloads into a second plane", () => {
  const store = new MemoryStagingDb();
  const first = new ControlPlane({
    store,
    now: () => NOW,
    code: () => "042315",
    authorizationRef: () => "aref_1",
  });
  first.redeemClaim("dev-1", first.issueClaim("dev-1").code);
  first.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant: ASSISTANT });
  const second = new ControlPlane({ store, now: () => NOW });
  assert.equal(second.getBinding("dev-1")?.authorizationRef, "aref_1");
  assert.equal(assistantEqual(second.getBinding("dev-1")?.assistant ?? {}, ASSISTANT), true);
});

test("a staging file cannot revive a firmware URL", () => {
  const store = new MemoryStagingDb();
  store.set("control", {
    version: 1,
    claims: [],
    bindings: [],
    ota: [
      {
        deviceId: "dev-1",
        version: "1",
        force: 0,
        firmwareUrl: "https://api.tenclass.net/xiaozhi/ota/fw.bin",
        executable: false,
        scope: "single-device",
        rollout: "lab-record-only",
      },
    ],
    credentials: [],
    revoked: [],
  });
  assert.throws(
    () => new ControlPlane({ store }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "state_corrupt",
  );
});
