import assert from "node:assert/strict";
import test from "node:test";

import {
  OPUS_PLACEHOLDER_MAGIC,
  SERVER_SAMPLE_RATE_DEFAULT,
  UPLINK_CHANNELS,
  UPLINK_SAMPLE_RATE,
  buildClientHello,
  buildWebsocketHeaders,
  parseServerHello,
} from "../adapters/metalio/src/index.ts";
import {
  MOCK_ASR_DEFAULT_TRANSCRIPT,
  MOCK_TTS_FRAME_COUNT,
  MockAsrProvider,
  MockTtsProvider,
  createMockAsrProvider,
  createMockTtsProvider,
  mockAsrTranscript,
  type AsrProvider,
  type TtsProvider,
} from "../adapters/voice/src/index.ts";
import { ControlPlane } from "../services/src/index.ts";
import { startLabVoiceServer } from "../services/src/lab-voice.ts";
import { connectLabVoice, type WsFrame } from "../services/src/voice-ws.ts";

test("mock ASR mirrors historical transcript rules", async () => {
  const asr = createMockAsrProvider();
  assert.equal(mockAsrTranscript({}), MOCK_ASR_DEFAULT_TRANSCRIPT);
  assert.equal(
    await asr.transcribe(Buffer.alloc(0), { sampleRate: UPLINK_SAMPLE_RATE, channels: UPLINK_CHANNELS }),
    MOCK_ASR_DEFAULT_TRANSCRIPT,
  );
  assert.equal(await asr.transcribe(Buffer.from("typed"), { sampleRate: 16000, channels: 1 }), "typed");
  assert.equal(
    await asr.transcribe(Buffer.from("ASR:from-audio"), { sampleRate: 16000, channels: 1, format: "pcm" }),
    "from-audio",
  );
  await assert.rejects(async () => {
    const stream = asr.stream;
    assert.ok(stream);
    for await (const _ of stream.call(asr, (async function* () {})())) {
      void _;
    }
  }, /reserved stub/);
});

test("mock TTS yields placeholder Opus frames at hello sample rate", async () => {
  const tts = createMockTtsProvider();
  const packets: Buffer[] = [];
  for await (const packet of tts.synthesize("hello", { sampleRate: SERVER_SAMPLE_RATE_DEFAULT })) {
    packets.push(packet);
  }
  assert.equal(packets.length, MOCK_TTS_FRAME_COUNT);
  assert.equal(packets.every((p) => p.equals(Buffer.from(OPUS_PLACEHOLDER_MAGIC))), true);
});

test("lab voice accepts injected AsrProvider and TtsProvider", async () => {
  let refs = 0;
  let tokens = 0;
  const control = new ControlPlane({
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
  control.redeemClaim("dev-voice", control.issueClaim("dev-voice").code);
  control.bind({
    deviceId: "dev-voice",
    digitalHumanId: "dh-voice",
    assistant: { voiceId: "voice-lab" },
  });
  const credential = control.issueConnectionCredential("dev-voice");

  const asrCalls: Array<{ bytes: number; sampleRate: number }> = [];
  const asr: AsrProvider = {
    async transcribe(audio, options) {
      asrCalls.push({ bytes: audio.byteLength, sampleRate: options.sampleRate });
      return "injected-asr";
    },
  };
  const customPacket = Buffer.from("CUSTOM-OPUS-FRAME");
  const tts: TtsProvider = {
    async *synthesize(text, options) {
      assert.equal(text, "injected-asr");
      assert.equal(options.sampleRate, 24000);
      yield customPacket;
      yield customPacket;
    },
  };

  const server = await startLabVoiceServer(control, {
    host: "127.0.0.1",
    port: 0,
    env: { OPENBOT_DEVICE_DH_TEST_MODE: "1" },
    asrProvider: asr,
    ttsProvider: tts,
  });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token: credential.token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const helloFrame = await client.nextFrame();
    const hello = parseServerHello(JSON.parse(helloFrame.payload.toString("utf8")));
    assert.equal(hello.sampleRate, 24000);
    const sessionId = hello.sessionId ?? "";
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "ignored-by-injected" }));

    const frames: WsFrame[] = [];
    for (let index = 0; index < 20; index += 1) {
      const frame = await client.nextFrame();
      frames.push(frame);
      if (frame.opcode === 1 && frame.payload.toString("utf8").includes('"state":"stop"')) {
        break;
      }
    }
    assert.equal(asrCalls.length, 1);
    assert.equal(asrCalls[0]?.sampleRate, UPLINK_SAMPLE_RATE);
    const texts = frames
      .filter((frame) => frame.opcode === 1)
      .map((frame) => JSON.parse(frame.payload.toString("utf8")) as { type?: string; text?: string; state?: string });
    assert.equal(texts.some((frame) => frame.type === "stt" && frame.text === "injected-asr"), true);
    assert.equal(
      texts.some((frame) => frame.type === "tts" && frame.state === "start" && frame.text === "injected-asr"),
      true,
    );
    const binaries = frames.filter((frame) => frame.opcode === 2);
    assert.equal(binaries.length >= 2, true);
    assert.equal(binaries[0]?.payload.equals(customPacket), true);
    assert.equal(binaries.every((frame) => !frame.payload.includes(OPUS_PLACEHOLDER_MAGIC)), true);
    client.close();
  } finally {
    await server.close();
  }
});

test("default MockAsrProvider and MockTtsProvider are constructible", () => {
  assert.ok(new MockAsrProvider());
  assert.ok(new MockTtsProvider(4));
});
