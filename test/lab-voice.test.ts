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

function bindDevice(control: ControlPlane): { token: string } {
  control.redeemClaim("dev-voice", control.issueClaim("dev-voice").code);
  control.bind({
    deviceId: "dev-voice",
    digitalHumanId: "dh-voice",
    assistant: { voiceId: "voice-lab" },
  });
  return { token: control.issueConnectionCredential("dev-voice").token };
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
