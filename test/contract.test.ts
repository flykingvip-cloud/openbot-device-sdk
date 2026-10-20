import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONSUMER_ROUTES,
  CONTRACT_PIN,
  DEVICE_EVENT_TYPES,
  DIGITAL_HUMAN_PROFILE_PATH,
  EVENT_ENVELOPE_TYPES,
  IMPLEMENTATION_GAPS,
  INTEGRATIONS_API_PREFIX,
  INVALIDATED_CONTRACT_SHAS,
  OLDER_CONTRACT_SHA,
  OPENAPI_FETCH,
  OPENAPI_SOURCE_URL,
  OPENBOT_CONTRACT_PR,
  OPENBOT_CONTRACT_REPO,
  OPENBOT_CONTRACT_SHA,
  PR7_PREMERGE_CONTRACT_SHA,
  PR7_SQUASH_CONTRACT_SHA,
  PR8_SQUASH_CONTRACT_SHA,
  PR10_SQUASH_CONTRACT_SHA,
  PR11_SQUASH_CONTRACT_SHA,
  PR16_SQUASH_CONTRACT_SHA,
  PR15_SQUASH_CONTRACT_SHA,
  PR14_SQUASH_CONTRACT_SHA,
  PR12_SQUASH_CONTRACT_SHA,
  PR9_SQUASH_CONTRACT_SHA,
  PREVIOUS_CONTRACT_SHA,
  RUN_EVENT_TYPES,
  STUB_SERVER_URL,
  alignConsumerRoutes,
  deviceAgentSessionKey,
  digitalHumanProfileUrl,
  loadStandInDocument,
  parseStandInDocument,
  resolveAgentSession,
} from "../contracts/src/index.ts";

test("OPENBOT_CONTRACT_SHA file matches the pin", () => {
  const file = readFileSync(new URL("../contracts/OPENBOT_CONTRACT_SHA", import.meta.url), "utf8").trim();
  assert.equal(file, OPENBOT_CONTRACT_SHA);
  assert.equal(file, "d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f");
  assert.equal(OPENBOT_CONTRACT_REPO, "https://github.com/flykingvip-cloud/openbot-vp");
  assert.equal(OPENBOT_CONTRACT_PR, "https://github.com/flykingvip-cloud/openbot-vp/pull/17");
  assert.equal(CONTRACT_PIN.status, "main");
  assert.equal(CONTRACT_PIN.merge, "squash");
  assert.equal(CONTRACT_PIN.officialMergeSha, OPENBOT_CONTRACT_SHA);
  assert.equal(CONTRACT_PIN.previousSha, PREVIOUS_CONTRACT_SHA);
  assert.equal(CONTRACT_PIN.previousShaStatus, "invalidated");
  assert.equal(PREVIOUS_CONTRACT_SHA, "490a69669c0cf9e68173ceb25cfa89c99438dfb9");
  assert.equal(PR16_SQUASH_CONTRACT_SHA, PREVIOUS_CONTRACT_SHA);
  assert.equal(PR15_SQUASH_CONTRACT_SHA, "feeac51863d6d88ba83c7e16029b2911209bb0d0");
  assert.equal(PR14_SQUASH_CONTRACT_SHA, "fe1e2c2a81fd3814e8588a854695640ca56db64b");
  assert.equal(PR12_SQUASH_CONTRACT_SHA, "92826116a9b00a596ae2360d8a643d6148050e3c");
  assert.equal(PR11_SQUASH_CONTRACT_SHA, "d22db4755311a1a0df9fb5e3d5da60554f8ef6a5");
  assert.equal(PR10_SQUASH_CONTRACT_SHA, "bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a");
  assert.equal(PR9_SQUASH_CONTRACT_SHA, "41b7561222775e4ad00b056e2a535c7f950bcbe9");
  assert.equal(PR8_SQUASH_CONTRACT_SHA, "536a963b119f0a00675516401c52dd0f6187b196");
  assert.equal(PR7_SQUASH_CONTRACT_SHA, "8abdc7f9a0ae49c340de712fbba235b1064f6c7d");
  assert.equal(PR7_PREMERGE_CONTRACT_SHA, "554910d835f3baadb1d753532ad510b1b477be09");
  assert.equal(OLDER_CONTRACT_SHA, "dd6c85cae086d90c519ff1be7ad08e20d4644bba");
  assert.deepEqual(INVALIDATED_CONTRACT_SHAS, [
    PREVIOUS_CONTRACT_SHA,
    PR15_SQUASH_CONTRACT_SHA,
    PR14_SQUASH_CONTRACT_SHA,
    PR12_SQUASH_CONTRACT_SHA,
    PR11_SQUASH_CONTRACT_SHA,
    PR10_SQUASH_CONTRACT_SHA,
    PR9_SQUASH_CONTRACT_SHA,
    PR8_SQUASH_CONTRACT_SHA,
    PR7_SQUASH_CONTRACT_SHA,
    PR7_PREMERGE_CONTRACT_SHA,
    OLDER_CONTRACT_SHA,
  ]);
  assert.equal((INVALIDATED_CONTRACT_SHAS as readonly string[]).includes(OPENBOT_CONTRACT_SHA), false);
  assert.equal(CONTRACT_PIN.deviceApisPresent, "reported-stub");
  assert.equal(CONTRACT_PIN.routesAligned, true);
  assert.equal(CONTRACT_PIN.access, "vendored");
  assert.equal(CONTRACT_PIN.routeSource, "vendored-openapi");
  assert.equal(CONTRACT_PIN.obsolete.shaPrefix, "68e062e");
  assert.equal(CONTRACT_PIN.obsolete.repo, "https://github.com/upbeyond/openbot");
});

test("B0-B5 stand-in stays local and does not flash", () => {
  const doc = loadStandInDocument();
  assert.equal(doc.status, "local-stand-in");
  assert.equal(doc.routeSource, "local-stand-in");
  assert.equal(doc.contract.deviceApisPresent, "reported-stub");
  assert.equal(doc.contract.routesAligned, true);
  assert.equal(doc.contract.access, "vendored");
  assert.equal(doc.contract.officialMergeSha, "d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f");
  assert.notEqual(doc.contract.officialMergeSha, "490a69669c0cf9e68173ceb25cfa89c99438dfb9");
  assert.notEqual(doc.contract.officialMergeSha, "feeac51863d6d88ba83c7e16029b2911209bb0d0");
  assert.notEqual(doc.contract.officialMergeSha, "fe1e2c2a81fd3814e8588a854695640ca56db64b");
  assert.notEqual(doc.contract.officialMergeSha, "92826116a9b00a596ae2360d8a643d6148050e3c");
  assert.notEqual(doc.contract.officialMergeSha, "d22db4755311a1a0df9fb5e3d5da60554f8ef6a5");
  assert.notEqual(doc.contract.officialMergeSha, "bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a");
  assert.notEqual(doc.contract.officialMergeSha, "41b7561222775e4ad00b056e2a535c7f950bcbe9");
  assert.notEqual(doc.contract.officialMergeSha, "536a963b119f0a00675516401c52dd0f6187b196");
  assert.equal(doc.contract.previousSha, PREVIOUS_CONTRACT_SHA);
  assert.equal(doc.contract.previousShaStatus, "invalidated");
  assert.deepEqual(doc.contract.invalidatedShas, [
    "490a69669c0cf9e68173ceb25cfa89c99438dfb9",
    "feeac51863d6d88ba83c7e16029b2911209bb0d0",
    "fe1e2c2a81fd3814e8588a854695640ca56db64b",
    "92826116a9b00a596ae2360d8a643d6148050e3c",
    "d22db4755311a1a0df9fb5e3d5da60554f8ef6a5",
    "bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a",
    "41b7561222775e4ad00b056e2a535c7f950bcbe9",
    "536a963b119f0a00675516401c52dd0f6187b196",
    "8abdc7f9a0ae49c340de712fbba235b1064f6c7d",
    "554910d835f3baadb1d753532ad510b1b477be09",
    "dd6c85cae086d90c519ff1be7ad08e20d4644bba",
  ]);
  const b1 = doc.apis.find((api) => api.id === "B1");
  assert.equal(b1?.path, "/api/integrations/v1/digital-humans/{digitalHumanId}");
  const b2 = doc.apis.find((api) => api.id === "B2");
  assert.equal(b2?.path, "/v1/device/sessions");
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

test("stand-in rejects a pin that hides the vendored OpenAPI", () => {
  const doc = structuredClone(loadStandInDocument()) as unknown as { contract: { routesAligned: boolean; sha: string } };
  doc.contract.routesAligned = false;
  assert.throws(() => parseStandInDocument(doc), /vendored OpenAPI/);
  doc.contract.routesAligned = true;
  doc.contract.sha = PREVIOUS_CONTRACT_SHA;
  assert.throws(() => parseStandInDocument(doc), /not pinned/);
  doc.contract.routesAligned = true;
  doc.contract.sha = PR8_SQUASH_CONTRACT_SHA;
  assert.throws(() => parseStandInDocument(doc), /not pinned/);
  doc.contract.sha = PR7_SQUASH_CONTRACT_SHA;
  assert.throws(() => parseStandInDocument(doc), /not pinned/);
  doc.contract.sha = PR7_PREMERGE_CONTRACT_SHA;
  assert.throws(() => parseStandInDocument(doc), /not pinned/);
  doc.contract.sha = OLDER_CONTRACT_SHA;
  assert.throws(() => parseStandInDocument(doc), /not pinned/);
});

test("vendored OpenAPI matches consumer paths and SSE event enums", () => {
  const slot = readFileSync(new URL("../contracts/openbot/device-digital-human.openapi.yaml", import.meta.url), "utf8");
  assert.match(slot, /^openapi: 3\.0\.3/m);
  assert.equal(slot.includes("unfetched:"), false);
  assert.match(slot, /http:\/\/127\.0\.0\.1:8787\/api\/integrations\/v1/);
  assert.match(slot, /in-flight replay returns the processing accept/);
  assert.equal(OPENAPI_FETCH.vendored, true);
  assert.equal(OPENAPI_FETCH.sha, OPENBOT_CONTRACT_SHA);
  assert.equal(OPENAPI_FETCH.routesAligned, true);
  assert.equal(OPENAPI_SOURCE_URL.includes(OPENBOT_CONTRACT_SHA), true);
  assert.equal(STUB_SERVER_URL, "http://127.0.0.1:8787/api/integrations/v1");
  assert.equal(DIGITAL_HUMAN_PROFILE_PATH, "/api/integrations/v1/digital-humans/{digitalHumanId}");
  assert.equal(digitalHumanProfileUrl("http://127.0.0.1:8787/", "dh/1"), "http://127.0.0.1:8787/api/integrations/v1/digital-humans/dh%2F1");
  const health = CONSUMER_ROUTES.find((route) => route.path === "/healthz");
  assert.equal(health?.underIntegrationsPrefix, false);
  assert.equal(slot.includes("\n  /healthz:"), false);
  for (const route of CONSUMER_ROUTES) {
    if (route.underIntegrationsPrefix) {
      assert.equal(route.path.startsWith(INTEGRATIONS_API_PREFIX), true);
    }
  }
  assert.equal(
    CONSUMER_ROUTES.some(
      (route) => route.path.endsWith("/conversations/{conversationId}/turns") && "idempotencyKey" in route,
    ),
    true,
  );
  const alignment = alignConsumerRoutes(slot);
  assert.deepEqual(alignment.gaps, []);
  assert.equal(alignment.aligned, true);
  assert.equal(CONTRACT_PIN.routesAligned, alignment.aligned);
  assert.deepEqual(RUN_EVENT_TYPES, [
    "run.accepted",
    "run.started",
    "assistant.delta",
    "assistant.visible",
    "assistant.final",
    "approval.required",
    "tool.request",
    "run.completed",
    "run.failed",
    "run.cancelled",
  ]);
  assert.deepEqual(DEVICE_EVENT_TYPES, [
    "tool.request",
    "authorization.revoked",
    "binding.updated",
    "run.cancelled",
  ]);
  assert.deepEqual(EVENT_ENVELOPE_TYPES, [
    ...RUN_EVENT_TYPES,
    "authorization.revoked",
    "binding.updated",
  ]);
  assert.equal(IMPLEMENTATION_GAPS.length > 0, true);
});

test("agent session key stays on device-dh unless force is exactly 1", () => {
  assert.equal(deviceAgentSessionKey("dh-1", "conv-9"), "device-dh:dh-1:conv-9");
  const kept = resolveAgentSession({
    digitalHumanId: "dh-1",
    conversationId: "conv-9",
    gatewayAgentId: "agent-lab",
    uiSessionKey: "ui-session",
    env: { OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE: "true" },
  });
  assert.equal(kept.sessionKey, "device-dh:dh-1:conv-9");
  assert.equal(kept.forced, false);
  assert.equal(kept.gatewayAgentId, "agent-lab");
  const forced = resolveAgentSession({
    digitalHumanId: "dh-1",
    conversationId: "conv-9",
    gatewayAgentId: "agent-lab",
    uiSessionKey: "ui-session",
    env: { OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE: "1" },
  });
  assert.equal(forced.sessionKey, "ui-session");
  assert.equal(forced.forced, true);
  assert.throws(
    () => resolveAgentSession({ digitalHumanId: "dh-1", conversationId: "conv-9", gatewayAgentId: "" }),
    /gatewayAgentId is required/,
  );
});
