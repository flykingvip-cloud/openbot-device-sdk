import assert from "node:assert/strict";
import test from "node:test";

import {
  SERVER_SAMPLE_RATE_DEFAULT,
  looksLikeRawOpusPacket,
} from "../adapters/metalio/src/index.ts";
import {
  MockAsrProvider,
  OpusFrameTtsProvider,
  ProportionalSilenceTtsProvider,
  buildOpenBotServiceHeaders,
  buildWavPcm,
  createAudioBridge,
  createMockAsrProvider,
  createProportionalSilenceTtsProvider,
  type AsrProvider,
  type AsrStreamChunk,
  type TtsProvider,
} from "../adapters/voice/src/index.ts";

function silentWav(pcmBytes = 640): Buffer {
  return buildWavPcm({
    pcm: Buffer.alloc(pcmBytes),
    sampleRate: 16_000,
    channels: 1,
    bitsPerSample: 16,
  });
}

test("audio bridge: wavBytes → AsrProvider.transcribe (no default pass-through)", async () => {
  const seen: Buffer[] = [];
  const asr: AsrProvider = {
    async transcribe(audio) {
      seen.push(audio);
      return "from-asr-provider";
    },
  };
  const tts: TtsProvider = {
    async *synthesize() {
      /* unused */
    },
  };
  const bridge = createAudioBridge({ asr, tts });
  const wav = silentWav();
  const text = await bridge.transcribeWav(wav);
  assert.equal(text, "from-asr-provider");
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.byteLength >= 44);
  // Bridge must not invent a passthrough transcript when ASR returns empty differently —
  // here we assert the return value is exactly what the provider returned.
  assert.notEqual(text, "claw4-upload-smoke");
});

test("audio bridge: assistantText → TtsProvider → Opus frames via proportional silence", async () => {
  const asr = createMockAsrProvider();
  const tts = createProportionalSilenceTtsProvider({ msPerChar: 60, minFrames: 1 });
  const bridge = createAudioBridge({ asr, tts, ttsSampleRate: SERVER_SAMPLE_RATE_DEFAULT });
  const short: Buffer[] = [];
  for await (const frame of bridge.synthesizeOpus("ab")) {
    short.push(frame);
  }
  const long: Buffer[] = [];
  for await (const frame of bridge.synthesizeOpus("abcdefghij")) {
    long.push(frame);
  }
  assert.ok(short.length >= 1);
  assert.ok(long.length > short.length, "longer text must yield more Opus frames (proportional silence)");
  assert.ok(short.every((f) => looksLikeRawOpusPacket(f)));
  assert.ok(long.every((f) => looksLikeRawOpusPacket(f)));
  if (tts instanceof ProportionalSilenceTtsProvider) {
    tts.destroy();
  }
});

test("audio bridge: abort cancels in-flight ASR and TTS", async () => {
  let releaseAsr: (() => void) | undefined;
  const asr: AsrProvider = {
    async transcribe() {
      await new Promise<void>((resolve) => {
        releaseAsr = resolve;
      });
      return "should-not-win";
    },
  };
  const tts: TtsProvider = {
    async *synthesize() {
      yield Buffer.from([0x01]);
      yield Buffer.from([0x02]);
      yield Buffer.from([0x03]);
    },
  };
  const bridge = createAudioBridge({ asr, tts });

  // Already-aborted signal rejects before/around provider work.
  const pre = bridge.createAbortHandle();
  pre.abort();
  await assert.rejects(() => bridge.transcribeWav(silentWav(), { signal: pre.signal }), /abort/i);

  // Abort while ASR is awaiting — bridge checks signal after provider returns.
  const mid = bridge.createAbortHandle();
  const pending = bridge.transcribeWav(silentWav(), { signal: mid.signal });
  await new Promise((r) => setImmediate(r));
  mid.abort();
  releaseAsr?.();
  await assert.rejects(() => pending, /abort/i);
  assert.equal(mid.aborted, true);

  const handle2 = bridge.createAbortHandle();
  const frames: Buffer[] = [];
  const synth = (async () => {
    for await (const frame of bridge.synthesizeOpus("hello", { signal: handle2.signal })) {
      frames.push(frame);
      handle2.abort();
    }
  })();
  await assert.rejects(() => synth, /abort/i);
  assert.ok(frames.length >= 1);
});

test("OpusFrameTtsProvider ignores text (format/lab only); bridge docs require real or proportional TTS", async () => {
  const lab = new OpusFrameTtsProvider({ frameCount: 3, pcmMode: "silence" });
  const a: Buffer[] = [];
  const b: Buffer[] = [];
  for await (const f of lab.synthesize("x", { sampleRate: SERVER_SAMPLE_RATE_DEFAULT })) {
    a.push(f);
  }
  for await (const f of lab.synthesize("xxxxxxxxxxxxxxxxxxxx", { sampleRate: SERVER_SAMPLE_RATE_DEFAULT })) {
    b.push(f);
  }
  assert.equal(a.length, b.length, "OpusFrameTtsProvider frame count ignores text length");
  lab.destroy();
});

test("AsrStreamChunk codec=opus shape is accepted by stream()", async () => {
  const asr = new MockAsrProvider();
  assert.ok(asr.stream);
  const chunk: AsrStreamChunk = {
    data: Buffer.from([0xfc, 0x00, 0x01]), // opaque opus-shaped bytes (not decoded in P0)
    codec: "opus",
    sampleRate: 16_000,
    channels: 1,
    endOfUtterance: true,
  };
  const results: Array<{ kind: string; text: string }> = [];
  for await (const item of asr.stream!(
    (async function* () {
      yield chunk;
    })(),
  )) {
    if ("final" in item && item.final !== undefined) {
      results.push({ kind: "final", text: item.final });
    } else if ("partial" in item) {
      results.push({ kind: "partial", text: item.partial });
    }
  }
  assert.ok(results.some((r) => r.kind === "final"));
});

test("device-edge auth sketch builds OpenBot service headers without device Basic", () => {
  const headers = buildOpenBotServiceHeaders(
    { authorization: "Basic c3ZjOnNlY3JldA==", grantCredential: "grant-xyz" },
    "dev-1",
  );
  assert.equal(headers.Authorization, "Basic c3ZjOnNlY3JldA==");
  assert.equal(headers["X-OpenBot-Grant-Credential"], "grant-xyz");
  assert.equal(headers["X-Device-Id"], "dev-1");
});

/**
 * P1 gap marker: full Opus uplink decode-to-PCM is not wired.
 * Keep as skipped so CI stays green while documenting the contract hole.
 */
test(
  "TODO(P1): Opus uplink decode-to-PCM or codec-aware Provider",
  { skip: "P0 types+docs+shape only; decode wiring deferred" },
  async () => {
    assert.fail("implement Opus→PCM before enabling");
  },
);
