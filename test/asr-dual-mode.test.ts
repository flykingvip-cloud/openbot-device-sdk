import assert from "node:assert/strict";
import test from "node:test";

import {
  UPLINK_CHANNELS,
  UPLINK_SAMPLE_RATE,
  buildClientHello,
  buildWebsocketHeaders,
  createLibopusFrameEncoder,
  parseServerHello,
  pcmBytesPerFrame,
} from "../adapters/metalio/src/index.ts";
import {
  MOCK_ASR_DEFAULT_TRANSCRIPT,
  MockAsrProvider,
  buildWavPcm,
  createMockAsrProvider,
  isWavBuffer,
  parseWavPcm,
  resolveAsrAudio,
  type AsrProvider,
  type AsrStreamChunk,
  type AsrStreamResult,
  type AsrUplinkCodec,
} from "../adapters/voice/src/index.ts";
import { ControlPlane } from "../services/src/index.ts";
import { startLabVoiceServer } from "../services/src/lab-voice.ts";
import { connectLabVoice, type WsFrame } from "../services/src/voice-ws.ts";

test("parseWavPcm reads sampleRate and channels from fmt chunk", () => {
  const pcm = Buffer.alloc(320, 0);
  const wav = buildWavPcm({ pcm, sampleRate: 16_000, channels: 1 });
  assert.equal(isWavBuffer(wav), true);
  const info = parseWavPcm(wav);
  assert.equal(info.sampleRate, 16_000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.pcm.byteLength, 320);
  assert.equal(info.pcm.equals(pcm), true);
});

test("resolveAsrAudio overrides options from WAVE header", () => {
  const pcm = Buffer.from("hello-pcm-not-text-\0");
  const wav = buildWavPcm({ pcm, sampleRate: 24_000, channels: 2 });
  const resolved = resolveAsrAudio(wav, {
    sampleRate: UPLINK_SAMPLE_RATE,
    channels: UPLINK_CHANNELS,
    format: "pcm",
  });
  // Auto-detect WAVE even if caller said pcm-ish defaults — looksWav wins when RIFF present.
  assert.equal(resolved.isWav, true);
  assert.equal(resolved.options.sampleRate, 24_000);
  assert.equal(resolved.options.channels, 2);
  assert.equal(resolved.options.format, "wav");
  assert.equal(resolved.pcm?.equals(pcm), true);
});

test("MockAsrProvider.transcribe uses WAV header rates and returns lab default for PCM", async () => {
  const asr = createMockAsrProvider();
  const pcm = Buffer.alloc(640, 1);
  const wav = buildWavPcm({ pcm, sampleRate: 8_000, channels: 1 });
  const seen: Array<{ sampleRate: number; channels: number; format: string }> = [];
  const wrapping: AsrProvider = {
    async transcribe(audio, options) {
      const resolved = resolveAsrAudio(audio, options);
      seen.push({
        sampleRate: resolved.options.sampleRate,
        channels: resolved.options.channels,
        format: resolved.options.format ?? "pcm",
      });
      return asr.transcribe(audio, options);
    },
  };
  assert.equal(await wrapping.transcribe(wav, { sampleRate: 16_000, channels: 1 }), MOCK_ASR_DEFAULT_TRANSCRIPT);
  assert.deepEqual(seen[0], { sampleRate: 8_000, channels: 1, format: "wav" });
});

test("MockAsrProvider.stream yields partial then final (usable WS stub)", async () => {
  const asr = new MockAsrProvider();
  async function* chunks(): AsyncIterable<AsrStreamChunk> {
    yield { data: Buffer.from("hel"), sampleRate: 16_000, channels: 1 };
    yield { data: Buffer.from("lo-stream"), endOfUtterance: true };
  }
  const results: AsrStreamResult[] = [];
  for await (const item of asr.stream(chunks())) {
    results.push(item);
  }
  assert.equal(results.length >= 2, true);
  assert.equal("partial" in results[0]!, true);
  assert.equal((results[0] as { partial: string }).partial, "hel");
  const last = results[results.length - 1]!;
  assert.equal("final" in last, true);
  assert.equal((last as { final: string }).final, "hello-stream");
});

test("lab voice finishUtterance sends whole-file WAV through AsrProvider", async () => {
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

  const asrCalls: Array<{ bytes: number; sampleRate: number; format: string }> = [];
  const asr: AsrProvider = {
    async transcribe(audio, options) {
      const resolved = resolveAsrAudio(audio, options);
      asrCalls.push({
        bytes: audio.byteLength,
        sampleRate: resolved.options.sampleRate,
        format: resolved.options.format ?? "pcm",
      });
      return "wav-transcript";
    },
  };

  const server = await startLabVoiceServer(control, {
    host: "127.0.0.1",
    port: 0,
    env: { OPENBOT_DEVICE_DH_TEST_MODE: "1" },
    asrProvider: asr,
  });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token: credential.token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const hello = parseServerHello(JSON.parse((await client.nextFrame()).payload.toString("utf8")));
    const sessionId = hello.sessionId ?? "";
    const wav = buildWavPcm({
      pcm: Buffer.alloc(160, 0),
      sampleRate: 16_000,
      channels: 1,
    });
    client.sendText(JSON.stringify({ type: "listen", state: "start", session_id: sessionId }));
    client.sendBinary(wav);
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));

    const frames: WsFrame[] = [];
    for (let index = 0; index < 30; index += 1) {
      const frame = await client.nextFrame();
      frames.push(frame);
      if (frame.opcode === 1 && frame.payload.toString("utf8").includes('"state":"stop"')) {
        break;
      }
    }
    assert.equal(asrCalls.length, 1);
    assert.equal(asrCalls[0]?.format, "wav");
    assert.equal(asrCalls[0]?.sampleRate, 16_000);
    assert.equal(asrCalls[0]?.bytes, wav.byteLength);
    const texts = frames
      .filter((frame) => frame.opcode === 1)
      .map((frame) => JSON.parse(frame.payload.toString("utf8")) as { type?: string; text?: string });
    assert.equal(texts.some((frame) => frame.type === "stt" && frame.text === "wav-transcript"), true);
    client.close();
  } finally {
    await server.close();
  }
});

test("lab voice finishUtterance calls asrProvider.stream for Opus packets (not labeled PCM)", async () => {
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

  const streamCodecs: AsrUplinkCodec[] = [];
  let streamCalls = 0;
  let transcribeCalls = 0;
  const asr: AsrProvider = {
    async transcribe() {
      transcribeCalls += 1;
      return "should-not-use-transcribe";
    },
    async *stream(chunks) {
      streamCalls += 1;
      for await (const chunk of chunks) {
        streamCodecs.push(chunk.codec ?? chunk.format ?? "pcm");
        if (chunk.endOfUtterance) {
          yield { final: "opus-stream-transcript" };
        }
      }
    },
  };

  const encoder = createLibopusFrameEncoder({ sampleRate: UPLINK_SAMPLE_RATE });
  const frameBytes = pcmBytesPerFrame(UPLINK_SAMPLE_RATE);
  const packetA = encoder.encodeFrame(Buffer.alloc(frameBytes));
  const packetB = encoder.encodeFrame(Buffer.alloc(frameBytes));
  encoder.destroy?.();

  const server = await startLabVoiceServer(control, {
    host: "127.0.0.1",
    port: 0,
    env: { OPENBOT_DEVICE_DH_TEST_MODE: "1" },
    asrProvider: asr,
  });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token: credential.token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const hello = parseServerHello(JSON.parse((await client.nextFrame()).payload.toString("utf8")));
    const sessionId = hello.sessionId ?? "";
    client.sendText(JSON.stringify({ type: "listen", state: "start", session_id: sessionId }));
    client.sendBinary(packetA);
    client.sendBinary(packetB);
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));

    const frames: WsFrame[] = [];
    for (let index = 0; index < 30; index += 1) {
      const frame = await client.nextFrame();
      frames.push(frame);
      if (frame.opcode === 1 && frame.payload.toString("utf8").includes('"state":"stop"')) {
        break;
      }
    }
    assert.equal(streamCalls, 1);
    assert.equal(transcribeCalls, 0);
    assert.ok(streamCodecs.length >= 1);
    assert.ok(streamCodecs.every((c) => c === "opus"), `expected opus codecs, got ${streamCodecs.join(",")}`);
    const texts = frames
      .filter((frame) => frame.opcode === 1)
      .map((frame) => JSON.parse(frame.payload.toString("utf8")) as { type?: string; text?: string });
    assert.equal(texts.some((frame) => frame.type === "stt" && frame.text === "opus-stream-transcript"), true);
    client.close();
  } finally {
    await server.close();
  }
});
