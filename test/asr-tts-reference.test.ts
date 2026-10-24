import assert from "node:assert/strict";
import test from "node:test";

import {
  SERVER_SAMPLE_RATE_DEFAULT,
  looksLikeRawOpusPacket,
} from "../adapters/metalio/src/index.ts";
import {
  ASR_HTTP_URL_ENV,
  ASR_PROVIDER_ENV,
  MOCK_ASR_DEFAULT_TRANSCRIPT,
  ReferenceHttpAsrProvider,
  ReferenceHttpTtsProvider,
  TTS_HTTP_URL_ENV,
  TTS_PROVIDER_ENV,
  buildWavPcm,
  createAudioBridge,
  createAudioBridgeFromVoiceEnv,
  createReferenceHttpAsrProvider,
  createReferenceHttpTtsProvider,
  createVoiceProvidersFromEnv,
  readVoiceReferenceEnv,
} from "../adapters/voice/src/index.ts";

function silentWav(pcmBytes = 640): Buffer {
  return buildWavPcm({
    pcm: Buffer.alloc(pcmBytes),
    sampleRate: 16_000,
    channels: 1,
    bitsPerSample: 16,
  });
}

/** Minimal mono s16le silence WAV at 24 kHz for TTS response mock. */
function silentWav24k(frameCount = 2): Buffer {
  const samplesPerFrame = (24_000 * 60) / 1000;
  const pcm = Buffer.alloc(samplesPerFrame * 2 * frameCount);
  return buildWavPcm({
    pcm,
    sampleRate: 24_000,
    channels: 1,
    bitsPerSample: 16,
  });
}

test("readVoiceReferenceEnv defaults to mock and never invents vendor URLs", () => {
  const selection = readVoiceReferenceEnv({});
  assert.equal(selection.asrKind, "mock");
  assert.equal(selection.ttsKind, "mock");
  assert.equal(selection.asrHttp, undefined);
  assert.equal(selection.ttsHttp, undefined);
});

test("reference-http ASR requires OPENBOT_ASR_HTTP_URL (no hardcoded host)", () => {
  assert.throws(
    () => readVoiceReferenceEnv({ [ASR_PROVIDER_ENV]: "reference-http" }),
    /OPENBOT_ASR_HTTP_URL/,
  );
  const selection = readVoiceReferenceEnv({
    [ASR_PROVIDER_ENV]: "funasr-http",
    [ASR_HTTP_URL_ENV]: "http://127.0.0.1:9/asr",
  });
  assert.equal(selection.asrKind, "reference-http");
  assert.equal(selection.asrHttp?.url, "http://127.0.0.1:9/asr");
});

test("createVoiceProvidersFromEnv default mock does not need FunASR/EdgeTTS", async () => {
  const bundle = createVoiceProvidersFromEnv({ env: {} });
  assert.equal(bundle.asrKind, "mock");
  assert.equal(bundle.ttsKind, "mock");
  const text = await bundle.asr.transcribe(Buffer.alloc(0), { sampleRate: 16_000, channels: 1 });
  assert.equal(text, MOCK_ASR_DEFAULT_TRANSCRIPT);
});

test("ReferenceHttpAsrProvider posts audio to configured URL (injectable fetch)", async () => {
  const calls: Array<{ url: string; method: string; contentType: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      contentType: new Headers(init?.headers).get("content-type"),
    });
    assert.ok(url.startsWith("http://127.0.0.1:9/funasr"));
    assert.ok(url.includes("model=SenseVoiceSmall"));
    return new Response(JSON.stringify({ text: "nihao" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const asr = createReferenceHttpAsrProvider({
    url: "http://127.0.0.1:9/funasr",
    model: "SenseVoiceSmall",
    fetchImpl,
  });
  const wav = silentWav();
  const text = await asr.transcribe(wav, { sampleRate: 16_000, channels: 1, format: "wav" });
  assert.equal(text, "nihao");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.contentType, "audio/wav");
});

test("ReferenceHttpTtsProvider encodes HTTP WAV into Opus frames (injectable fetch)", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.text, "hello");
    assert.equal(body.sampleRate, SERVER_SAMPLE_RATE_DEFAULT);
    assert.equal(body.voice, "zh-CN-XiaoxiaoNeural");
    return new Response(new Uint8Array(silentWav24k(2)), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  };
  const tts = createReferenceHttpTtsProvider({
    url: "http://127.0.0.1:9/edgetts",
    voice: "zh-CN-XiaoxiaoNeural",
    fetchImpl,
  });
  const frames: Buffer[] = [];
  for await (const frame of tts.synthesize("hello", { sampleRate: SERVER_SAMPLE_RATE_DEFAULT })) {
    frames.push(frame);
  }
  assert.equal(frames.length, 2);
  assert.ok(frames.every((f) => looksLikeRawOpusPacket(f)));
  if (tts instanceof ReferenceHttpTtsProvider) {
    tts.destroy();
  }
});

test("createAudioBridgeFromVoiceEnv wires reference-http via env + fetch", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/asr")) {
      return new Response(JSON.stringify({ text: "from-ref-asr" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/tts")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.text, "speak-me");
      return new Response(new Uint8Array(silentWav24k(1)), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }
    return new Response("nope", { status: 404 });
  };
  const bridge = createAudioBridgeFromVoiceEnv({
    env: {
      [ASR_PROVIDER_ENV]: "reference-http",
      [ASR_HTTP_URL_ENV]: "http://127.0.0.1:9/asr",
      [TTS_PROVIDER_ENV]: "reference-http",
      [TTS_HTTP_URL_ENV]: "http://127.0.0.1:9/tts",
    },
    fetchImpl,
  });
  assert.equal(await bridge.transcribeWav(silentWav()), "from-ref-asr");
  const frames: Buffer[] = [];
  for await (const frame of bridge.synthesizeOpus("speak-me")) {
    frames.push(frame);
  }
  assert.ok(frames.length >= 1);
  assert.ok(frames.every((f) => looksLikeRawOpusPacket(f)));
});

test("createAudioBridgeFromVoiceEnv forbids opus-frame for product spoken TTS", () => {
  assert.throws(
    () =>
      createAudioBridgeFromVoiceEnv({
        env: { [TTS_PROVIDER_ENV]: "opus-frame" },
      }),
    /lab\/format only|OpusFrameTtsProvider|spoken/i,
  );
});

test("explicit createAudioBridge still accepts reference providers", async () => {
  const asr = new ReferenceHttpAsrProvider({
    url: "http://127.0.0.1:9/a",
    fetchImpl: async () =>
      new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const tts = new ReferenceHttpTtsProvider({
    url: "http://127.0.0.1:9/t",
    fetchImpl: async () =>
      new Response(new Uint8Array(silentWav24k(1)), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      }),
  });
  const bridge = createAudioBridge({ asr, tts });
  assert.equal(await bridge.transcribeWav(silentWav()), "ok");
  tts.destroy();
});
