import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONTRACT_PIN,
  OPENBOT_CONTRACT_PR,
  OPENBOT_CONTRACT_REPO,
  OPENBOT_CONTRACT_SHA,
  PREVIOUS_CONTRACT_SHA,
  loadStandInDocument,
  parseStandInDocument,
} from "../contracts/src/index.ts";

test("OPENBOT_CONTRACT_SHA file matches the pin", () => {
  const file = readFileSync(new URL("../contracts/OPENBOT_CONTRACT_SHA", import.meta.url), "utf8").trim();
  assert.equal(file, OPENBOT_CONTRACT_SHA);
  assert.equal(file, "554910d835f3baadb1d753532ad510b1b477be09");
  assert.equal(OPENBOT_CONTRACT_REPO, "https://github.com/flykingvip-cloud/openbot-vp");
  assert.equal(OPENBOT_CONTRACT_PR, "https://github.com/flykingvip-cloud/openbot-vp/pull/7");
  assert.equal(CONTRACT_PIN.status, "pre-merge-tip");
  assert.equal(CONTRACT_PIN.officialMergeSha, null);
  assert.equal(CONTRACT_PIN.previousSha, PREVIOUS_CONTRACT_SHA);
  assert.equal(PREVIOUS_CONTRACT_SHA, "dd6c85cae086d90c519ff1be7ad08e20d4644bba");
  assert.equal(CONTRACT_PIN.deviceApisPresent, "unverified");
  assert.equal(CONTRACT_PIN.routesAligned, false);
  assert.equal(CONTRACT_PIN.access, "unreadable-404");
  assert.equal(CONTRACT_PIN.routeSource, "local-mock-access-limited");
  assert.equal(CONTRACT_PIN.obsolete.shaPrefix, "68e062e");
  assert.equal(CONTRACT_PIN.obsolete.repo, "https://github.com/upbeyond/openbot");
});

test("B0-B5 stand-in stays local and does not flash", () => {
  const doc = loadStandInDocument();
  assert.equal(doc.status, "local-stand-in");
  assert.equal(doc.routeSource, "local-mock-access-limited");
  assert.equal(doc.contract.deviceApisPresent, "unverified");
  assert.equal(doc.contract.routesAligned, false);
  assert.equal(doc.contract.access, "unreadable-404");
  assert.equal(doc.contract.officialMergeSha, null);
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
  assert.deepEqual(doc.consumerChecks, {
    B1: ["idempotent-read"],
    B2: ["idempotency-key", "SESSION_BUSY", "CURSOR_EXPIRED", "eventId-dedupe"],
    B3: ["idempotency-key", "assistant.visible-only-tts"],
  });
});

test("stand-in rejects a pin that pretends the PR routes were copied", () => {
  const doc = structuredClone(loadStandInDocument()) as unknown as { contract: { routesAligned: boolean; sha: string } };
  doc.contract.routesAligned = true;
  assert.throws(() => parseStandInDocument(doc), /local until the PR tip can be read/);
  doc.contract.routesAligned = false;
  doc.contract.sha = PREVIOUS_CONTRACT_SHA;
  assert.throws(() => parseStandInDocument(doc), /not pinned/);
});
