import assert from "node:assert/strict";
import test from "node:test";

import { readDigitalHuman } from "../integrations/openbot-b1/src/index.ts";
import { SESSION_CURSOR_TTL_MS, SessionBook, SessionError } from "../integrations/openbot-b2/src/index.ts";
import { IdempotencyConflictError, ToolAuthError, invokeOpenBotTool } from "../integrations/openbot-b3/src/index.ts";
import { ControlPlane, OtaDisabledError } from "../services/src/index.ts";

const PROFILE_A = { name: "A", visible: { speech: "hello-a" } };
const PROFILE_B = { name: "B", visible: { speech: "hello-b" } };

function claimedPlane(): { plane: ControlPlane; now: { value: number } } {
  const now = { value: 1_700_000_000_000 };
  let refs = 0;
  const plane = new ControlPlane({
    now: () => now.value,
    code: () => "100001",
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
  });
  plane.redeemClaim("dev-1", plane.issueClaim("dev-1").code);
  return { plane, now };
}

test("P1 revoke and rebind close the old session and allow a new run", () => {
  const { plane, now } = claimedPlane();
  let nextSession = 0;
  const book = new SessionBook({
    plane,
    now: () => now.value,
    sessionId: () => {
      nextSession += 1;
      return `sess_${nextSession}`;
    },
  });
  const firstBinding = plane.bind({ deviceId: "dev-1", digitalHumanId: "dh-a", assistant: PROFILE_A });
  const opened = book.open({
    authorizationRef: firstBinding.authorizationRef,
    bindingVersion: firstBinding.bindingVersion,
    digitalHumanId: firstBinding.digitalHumanId,
    deviceId: firstBinding.deviceId,
    idempotencyKey: "run-a",
  });
  assert.equal(book.append(opened.sessionId, { eventId: "evt-1", type: "device.turn" }).accepted, true);

  plane.revoke("dev-1");
  assert.throws(
    () => book.append(opened.sessionId, { eventId: "evt-late", type: "device.turn" }),
    (error: unknown) => error instanceof SessionError && error.code === "SESSION_CLOSED",
  );
  assert.throws(
    () => book.pull(opened.sessionId, 0),
    (error: unknown) => error instanceof SessionError && error.code === "SESSION_CLOSED",
  );

  const rebound = plane.rebind("dev-1", { digitalHumanId: "dh-b", assistant: PROFILE_B });
  assert.equal(rebound.bindingVersion, 2);
  assert.equal(rebound.assistant.name, "B");
  assert.equal(rebound.assistant.visible && (rebound.assistant.visible as { speech: string }).speech, "hello-b");
  const resumed = book.open({
    authorizationRef: rebound.authorizationRef,
    bindingVersion: rebound.bindingVersion,
    digitalHumanId: rebound.digitalHumanId,
    deviceId: rebound.deviceId,
    idempotencyKey: "run-a",
  });
  assert.notEqual(resumed.sessionId, opened.sessionId);
  assert.equal(resumed.binding.authorizationRef, rebound.authorizationRef);
  assert.equal(resumed.binding.bindingVersion, 2);
  assert.throws(
    () => book.append(opened.sessionId, { eventId: "evt-2", type: "device.turn" }),
    (error: unknown) => error instanceof SessionError && error.code === "SESSION_CLOSED",
  );
  assert.equal(book.pull(resumed.sessionId, 0).events.length, 0);
  assert.throws(() => plane.flash(), OtaDisabledError);
  assert.throws(() => plane.massFlash(), OtaDisabledError);
});

test("P1 release and cursor expiry invalidate the old session", () => {
  const { plane, now } = claimedPlane();
  let nextSession = 0;
  const book = new SessionBook({
    plane,
    now: () => now.value,
    sessionId: () => {
      nextSession += 1;
      return `sess_life_${nextSession}`;
    },
  });
  const binding = plane.bind({ deviceId: "dev-1", digitalHumanId: "dh-a", assistant: PROFILE_A });
  const request = {
    authorizationRef: binding.authorizationRef,
    bindingVersion: binding.bindingVersion,
    digitalHumanId: binding.digitalHumanId,
    deviceId: binding.deviceId,
    idempotencyKey: "run-live",
  };
  const opened = book.open(request);
  assert.equal(book.release(opened.sessionId).released, true);
  assert.throws(
    () => book.append(opened.sessionId, { eventId: "evt-1", type: "device.turn" }),
    (error: unknown) => error instanceof SessionError && error.code === "SESSION_CLOSED",
  );
  const afterClose = book.open({ ...request, idempotencyKey: "run-after-close" });
  assert.notEqual(afterClose.sessionId, opened.sessionId);

  now.value += SESSION_CURSOR_TTL_MS;
  assert.throws(
    () => book.pull(afterClose.sessionId, 0),
    (error: unknown) => error instanceof SessionError && error.code === "CURSOR_EXPIRED",
  );
  const afterExpiry = book.open({ ...request, idempotencyKey: "run-after-expiry" });
  assert.notEqual(afterExpiry.sessionId, afterClose.sessionId);
  assert.equal(book.append(afterExpiry.sessionId, { eventId: "evt-new", type: "device.turn" }).accepted, true);
});

test("P1 rebind replaces assistant values and drops the old profile cache", async () => {
  const { plane } = claimedPlane();
  const first = plane.bind({ deviceId: "dev-1", digitalHumanId: "dh-a", assistant: PROFILE_A });
  const cached = await readDigitalHuman("dh-a", { plane, idempotencyKey: "profile-1" });
  assert.equal(cached.assistant.name, "A");
  const second = plane.rebind("dev-1", { digitalHumanId: "dh-a", assistant: PROFILE_B });
  assert.equal(second.authorizationRef === first.authorizationRef, false);
  assert.equal(second.bindingVersion, first.bindingVersion + 1);
  assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
  const loaded = await readDigitalHuman("dh-a", { plane, idempotencyKey: "profile-1" });
  assert.equal(loaded.assistant.name, "B");
  assert.equal((loaded.assistant.visible as { speech: string }).speech, "hello-b");
  assert.equal(plane.getBinding("dev-1")?.assistant.name, "B");
});

test("P1 idempotency conflicts when the request changes and checks revocation first", () => {
  const { plane } = claimedPlane();
  const binding = plane.bind({ deviceId: "dev-1", digitalHumanId: "dh-a", assistant: PROFILE_A });
  const cache = new Map();
  const scope = {
    deviceId: binding.deviceId,
    authorizationRef: binding.authorizationRef,
    bindingVersion: binding.bindingVersion,
    sessionId: "sess-1",
  };
  const options = { idempotencyKey: "tool-1", idempotency: cache, scope, plane };
  const started = invokeOpenBotTool("voice.listen.start", { sessionId: "sess-1" }, options);
  assert.equal(started.result.name, "voice.listen.start");
  const replay = invokeOpenBotTool("voice.listen.start", { sessionId: "sess-1" }, options);
  assert.equal(replay.result.name, "voice.listen.start");
  if (replay.result.name !== "voice.listen.start" || started.result.name !== "voice.listen.start") {
    throw new Error("expected listen start");
  }
  assert.equal(replay.result.wire, started.result.wire);
  assert.throws(
    () => invokeOpenBotTool("voice.abort", { sessionId: "sess-2" }, { ...options, scope: { ...scope, sessionId: "sess-2" } }),
    (error: unknown) => error instanceof IdempotencyConflictError,
  );
  plane.revoke("dev-1");
  assert.throws(
    () => invokeOpenBotTool("voice.listen.start", { sessionId: "sess-1" }, options),
    (error: unknown) => error instanceof ToolAuthError && error.code === "tool_revoked",
  );
});
