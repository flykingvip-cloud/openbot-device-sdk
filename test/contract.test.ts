import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONTRACT_PIN,
  OPENBOT_CONTRACT_REPO,
  OPENBOT_CONTRACT_SHA,
  loadStandInDocument,
} from "../contracts/src/index.ts";

test("OPENBOT_CONTRACT_SHA file matches the pin", () => {
  const file = readFileSync(new URL("../contracts/OPENBOT_CONTRACT_SHA", import.meta.url), "utf8").trim();
  assert.equal(file, OPENBOT_CONTRACT_SHA);
  assert.equal(file, "dd6c85cae086d90c519ff1be7ad08e20d4644bba");
  assert.equal(OPENBOT_CONTRACT_REPO, "https://github.com/flykingvip-cloud/openbot-vp");
  assert.equal(CONTRACT_PIN.deviceApisPresent, false);
  assert.equal(CONTRACT_PIN.snapshot, "parentless-recovery");
  assert.equal(CONTRACT_PIN.obsolete.shaPrefix, "68e062e");
  assert.equal(CONTRACT_PIN.obsolete.repo, "https://github.com/upbeyond/openbot");
});

test("B0-B5 stand-in stays local and does not flash", () => {
  const doc = loadStandInDocument();
  assert.equal(doc.status, "local-stand-in");
  assert.equal(doc.contract.deviceApisPresent, false);
  assert.deepEqual(
    doc.apis.map((api) => api.id),
    ["B0", "B1", "B2", "B3", "B4", "B5"],
  );
  const b5 = doc.apis.find((api) => api.id === "B5");
  assert.equal(b5?.flash, false);
  assert.deepEqual(doc.frozenFields.topLevel, [
    "authorizationRef",
    "bindingVersion",
    "digitalHumanId",
    "deviceId",
  ]);
  assert.deepEqual(doc.frozenFields.prefixes, ["assistant."]);
});
