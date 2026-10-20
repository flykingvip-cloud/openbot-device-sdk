import assert from "node:assert/strict";
import test from "node:test";

import {
  DECODE_QUEUE_BUDGET_MS,
  OPUS_PLACEHOLDER_MAGIC,
  buildAbortMessage,
  buildClientHello,
  buildWebsocketHeaders,
  parseServerHello,
} from "../adapters/metalio/src/index.ts";
import { ControlPlane } from "../services/src/index.ts";
import { LabPlayQueue, mockAsrTranscript, startLabVoiceServer } from "../services/src/lab-voice.ts";
import { connectLabVoice, type WsFrame } from "../services/src/voice-ws.ts";

function plane(): ControlPlane {
  let refs = 0;
  let tokens = 0;
  return new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => "042315",
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
    token: () => {
      tokens += 1;
      return `ctok_${tokens}`;
    },
  });
}

function planeClock(now: () => number): ControlPlane {
  let refs = 0;
  let tokens = 0;
  return new ControlPlane({
    now,
    code: () => "042315",
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
    token: () => {
      tokens += 1;
      return `ctok_${tokens}`;
    },
  });
}

function bindDevice(control: ControlPlane): { token: string; expiresAtMs: number } {
  control.redeemClaim("dev-voice", control.issueClaim("dev-voice").code);
  control.bind({
    deviceId: "dev-voice",
    digitalHumanId: "dh-voice",
    assistant: { voiceId: "voice-lab" },
  });
  const credential = control.issueConnectionCredential("dev-voice");
  return { token: credential.token, expiresAtMs: credential.expiresAtMs };
}

async function readUntil(client: { nextFrame: () => Promise<WsFrame> }, accept: (frame: WsFrame) => boolean): Promise<WsFrame[]> {
  const frames: WsFrame[] = [];
  for (let index = 0; index < 40; index += 1) {
    const frame = await client.nextFrame();
    frames.push(frame);
    if (accept(frame)) {
      return frames;
    }
  }
  throw new Error("lab voice frame was not received");
}

test("play queue keeps the 2400 ms residual and does not clear it on abort", () => {
  const queue = new LabPlayQueue();
  queue.start();
  const frame = Buffer.from(OPUS_PLACEHOLDER_MAGIC);
  for (let index = 0; index < 40; index += 1) {
    assert.equal(queue.sent(frame), "queued");
  }
  assert.equal(queue.sent(frame), "blocked");
  assert.equal(queue.residualMs(), DECODE_QUEUE_BUDGET_MS);
  const report = queue.abort("sess_lab");
  assert.equal(report.queueCleared, false);
  assert.equal(report.residualMs, 2400);
  assert.equal(mockAsrTranscript({}), "lab-transcript");
  assert.equal(mockAsrTranscript({ binaryNote: "ASR:from-audio" }), "from-audio");
  assert.equal(mockAsrTranscript({ listenText: "typed" }), "typed");
});

test("lab voice accepts Metalio hello, hands a turn to B2, and stops TTS on abort", async () => {
  const control = plane();
  const { token } = bindDevice(control);
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0 });
  try {
    await assert.rejects(
      () => connectLabVoice(server.url, buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1" })),
      /401/,
    );
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const helloFrame = await client.nextFrame();
    assert.equal(helloFrame.opcode, 1);
    const hello = parseServerHello(JSON.parse(helloFrame.payload.toString("utf8")));
    assert.equal(hello.transport, "websocket");
    assert.equal(hello.sampleRate, 24000);
    assert.equal(hello.frameDurationMs, 60);
    const sessionId = hello.sessionId ?? "";
    assert.equal(sessionId.length > 0, true);

    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "lab-heard" }));
    const beforeAbort = await readUntil(client, (frame) => frame.opcode === 2);
    assert.equal(beforeAbort.some((frame) => frame.payload.toString("utf8").includes("lab-heard")), true);
    assert.equal(beforeAbort.some((frame) => frame.payload.includes(OPUS_PLACEHOLDER_MAGIC)), true);

    client.sendText(buildAbortMessage(sessionId, "wake_word_detected"));
    const untilAbort = await readUntil(client, (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("lab.abort"));
    const abortBody = JSON.parse(untilAbort[untilAbort.length - 1]?.payload.toString("utf8") ?? "{}") as {
      residualMs: number;
      queueCleared: boolean;
      residualCapMs: number;
    };
    assert.equal(abortBody.queueCleared, false);
    assert.equal(abortBody.residualCapMs, 2400);
    assert.equal(abortBody.residualMs > 0, true);
    assert.equal(abortBody.residualMs <= 2400, true);
    assert.equal(abortBody.residualMs % 60, 0);

    const extra = await Promise.race([
      client.nextFrame(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 40);
      }),
    ]);
    assert.equal(extra, null);

    const pulled = server.book.pull(sessionId, 0);
    assert.equal(pulled.events.length, 1);
    assert.equal(pulled.events[0]?.type, "user.turn");
    assert.equal(server.url.includes("tenclass"), false);
    client.close();
  } finally {
    await server.close();
  }
});

test("expired token is rejected on connect", async () => {
  let now = 1_700_000_000_000;
  const control = planeClock(() => now);
  const { token, expiresAtMs } = bindDevice(control);
  now = expiresAtMs;
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0 });
  try {
    await assert.rejects(
      () => connectLabVoice(server.url, buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token })),
      /401/,
    );
    const decision = control.assessConnectionCredential("dev-voice", token);
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.code, "credential_expired");
    }
  } finally {
    await server.close();
  }
});

test("mid-session expiry closes the socket and does not finish the utterance", async () => {
  let now = 1_700_000_000_000;
  const control = planeClock(() => now);
  const { token, expiresAtMs } = bindDevice(control);
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0 });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const helloFrame = await client.nextFrame();
    const hello = parseServerHello(JSON.parse(helloFrame.payload.toString("utf8")));
    const sessionId = hello.sessionId ?? "";
    assert.equal(sessionId.length > 0, true);
    assert.equal(server.book.pull(sessionId, 0).events.some((event) => event.type === "user.turn"), false);

    now = expiresAtMs;
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "too-late" }));
    const frame = await client.nextFrame();
    assert.equal(frame.opcode, 1);
    const body = JSON.parse(frame.payload.toString("utf8")) as { type: string; code: string };
    assert.equal(body.type, "error");
    assert.equal(body.code, "credential_expired");
    assert.equal(server.book.pull(sessionId, 0).events.some((event) => event.type === "user.turn"), false);
    assert.equal(server.book.pull(sessionId, 0).events.some((event) => event.type === "stt"), false);
    client.close();
  } finally {
    await server.close();
  }
});
