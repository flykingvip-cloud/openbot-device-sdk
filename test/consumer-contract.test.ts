import assert from "node:assert/strict";
import test from "node:test";

import { LIVE_STUB_ENV, type FrozenBinding } from "../contracts/src/index.ts";
import { readDigitalHuman } from "../integrations/openbot-b1/src/index.ts";
import {
  SESSION_CURSOR_TTL_MS,
  SessionBook,
  SessionError,
} from "../integrations/openbot-b2/src/index.ts";
import { IdempotencyConflictError, VisibleTtsError, invokeOpenBotTool } from "../integrations/openbot-b3/src/index.ts";
import { ControlPlane, MemoryStagingDb } from "../services/src/index.ts";

const SECRET = "do-not-speak-secret";
const VISIBLE = "visible-speech-only";

test("b1 idempotent read keeps the first assistant profile", async () => {
  let calls = 0;
  let armed = true;
  const binding: FrozenBinding = {
    authorizationRef: "aref_1",
    bindingVersion: 1,
    digitalHumanId: "dh-9",
    deviceId: "dev-9",
    assistant: {
      voiceId: "v",
      systemPrompt: SECRET,
      visible: { speech: VISIBLE },
    },
  };
  const plane = {
    findByDigitalHuman(): readonly FrozenBinding[] {
      calls += 1;
      return armed ? [binding] : [];
    },
  };
  const first = await readDigitalHuman("dh-9", { plane, idempotencyKey: "read-1" });
  armed = false;
  (first.assistant as { voiceId: string }).voiceId = "mutated";
  const again = await readDigitalHuman("dh-9", { plane, idempotencyKey: "read-1" });
  assert.equal(calls, 1);
  assert.equal(again.assistant.voiceId, "v");
  assert.equal(again.assistant.systemPrompt, SECRET);
});

test("b1 live stub idempotency does not refetch", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        digitalHumanId: "dh",
        assistant: { visible: { speech: "hi" }, secret: "nope" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const env = { [LIVE_STUB_ENV]: "http://127.0.0.1:9" } as NodeJS.ProcessEnv;
  const idempotency = new Map();
  const first = await readDigitalHuman("dh", { env, fetchImpl, idempotencyKey: "stub-1", idempotency });
  const second = await readDigitalHuman("dh", { env, fetchImpl, idempotencyKey: "stub-1", idempotency });
  assert.equal(calls, 1);
  assert.equal(first.assistant.secret, "nope");
  assert.equal(second.assistant.secret, "nope");
});

test("b2 idempotency, SESSION_BUSY, CURSOR_EXPIRED, and eventId dedupe survive reload", () => {
  let now = 1_700_000_000_000;
  const store = new MemoryStagingDb();
  const plane = new ControlPlane({
    store,
    now: () => now,
    code: () => "100001",
    authorizationRef: () => "aref_1",
  });
  plane.redeemClaim("dev-1", plane.issueClaim("dev-1").code);
  const binding = plane.bind({
    deviceId: "dev-1",
    digitalHumanId: "dh-1",
    assistant: { voiceId: "v" },
  });
  const book = new SessionBook({
    plane,
    store,
    now: () => now,
    sessionId: () => "sess_lab",
  });
  const request = {
    authorizationRef: binding.authorizationRef,
    bindingVersion: binding.bindingVersion,
    digitalHumanId: binding.digitalHumanId,
    deviceId: binding.deviceId,
    idempotencyKey: "open-1",
  };
  const first = book.open(request);
  const second = book.open(request);
  assert.equal(first.sessionId, "sess_lab");
  assert.equal(second.sessionId, first.sessionId);
  assert.throws(
    () => book.open({ ...request, idempotencyKey: "open-2" }),
    (error: unknown) => error instanceof SessionError && error.code === "SESSION_BUSY",
  );
  const appended = book.append(first.sessionId, { eventId: "evt-1", type: "device.heartbeat" });
  const duplicate = book.append(first.sessionId, { eventId: "evt-1", type: "device.heartbeat" });
  assert.equal(appended.accepted, true);
  assert.equal(appended.cursor, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(book.pull(first.sessionId, 0).events.length, 1);

  const reloadedPlane = new ControlPlane({ store, now: () => now });
  const reloaded = new SessionBook({ plane: reloadedPlane, store, now: () => now });
  const again = reloaded.append(first.sessionId, { eventId: "evt-1", type: "device.heartbeat" });
  assert.equal(again.duplicate, true);
  assert.equal(reloaded.pull(first.sessionId, 0).events.length, 1);
  assert.throws(
    () =>
      reloaded.open({
        authorizationRef: binding.authorizationRef,
        bindingVersion: binding.bindingVersion,
        digitalHumanId: binding.digitalHumanId,
        deviceId: binding.deviceId,
        idempotencyKey: "open-3",
      }),
    (error: unknown) => error instanceof SessionError && error.code === "SESSION_BUSY",
  );

  now += SESSION_CURSOR_TTL_MS;
  assert.throws(
    () => reloaded.pull(first.sessionId, 0),
    (error: unknown) => error instanceof SessionError && error.code === "CURSOR_EXPIRED",
  );
  assert.throws(
    () => reloaded.append(first.sessionId, { eventId: "evt-2", type: "device.heartbeat" }),
    (error: unknown) => error instanceof SessionError && error.code === "CURSOR_EXPIRED",
  );
});

test("b3 speaks only assistant.visible.speech and replays the first invocation", () => {
  const assistant = {
    voiceId: "v",
    systemPrompt: SECRET,
    visible: { speech: VISIBLE, note: SECRET },
  };
  const cache = new Map();
  const first = invokeOpenBotTool(
    "assistant.tts",
    { sessionId: "sess_lab", assistant },
    { idempotencyKey: "tts-1", idempotency: cache },
  );
  const second = invokeOpenBotTool(
    "assistant.tts",
    { sessionId: "sess_lab", assistant },
    { idempotencyKey: "tts-1", idempotency: cache },
  );
  assert.throws(
    () =>
      invokeOpenBotTool(
        "assistant.tts",
        { sessionId: "sess_lab", assistant: { visible: { speech: "other" }, systemPrompt: SECRET } },
        { idempotencyKey: "tts-1", idempotency: cache },
      ),
    (error: unknown) => error instanceof IdempotencyConflictError,
  );
  assert.equal(first.result.name, "assistant.tts");
  assert.equal(second.result.name, "assistant.tts");
  if (first.result.name !== "assistant.tts" || second.result.name !== "assistant.tts") {
    throw new Error("expected visible TTS result");
  }
  assert.equal(first.result.visibleOnly, true);
  assert.equal(first.result.text, VISIBLE);
  assert.equal(second.result.text, VISIBLE);
  assert.equal(first.result.wire.includes(SECRET), false);
  assert.deepEqual(JSON.parse(first.result.wire), {
    session_id: "sess_lab",
    type: "tts",
    state: "sentence_start",
    text: VISIBLE,
  });
  assert.throws(
    () => invokeOpenBotTool("assistant.tts", { sessionId: "sess_lab", assistant: { voiceId: "v", systemPrompt: SECRET } }),
    (error: unknown) => error instanceof VisibleTtsError && !error.message.includes(SECRET),
  );

  const toolCache = new Map();
  invokeOpenBotTool("media.describe", {}, { idempotencyKey: "once", idempotency: toolCache });
  const replay = invokeOpenBotTool("media.describe", {}, { idempotencyKey: "once", idempotency: toolCache });
  assert.equal(replay.result.name, "media.describe");
  assert.throws(
    () => invokeOpenBotTool("ota.flash", {}, { idempotencyKey: "once", idempotency: toolCache }),
    (error: unknown) => error instanceof IdempotencyConflictError,
  );
  assert.throws(() => invokeOpenBotTool("ota.massFlash"), /disabled/);
  assert.throws(() => invokeOpenBotTool("system.reboot"), /disabled/);
});
