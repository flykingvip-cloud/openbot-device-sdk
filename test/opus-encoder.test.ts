import assert from "node:assert/strict";
import test from "node:test";

import {
  OPUS_FRAME_DURATION_MS,
  OPUS_PLACEHOLDER_MAGIC,
  SERVER_SAMPLE_RATE_DEFAULT,
  createLibopusFrameEncoder,
  isOpusPlaceholderPayload,
  looksLikeRawOpusPacket,
  pcmBytesPerFrame,
  placeholderEncode,
} from "../adapters/metalio/src/index.ts";
import {
  MOCK_TTS_FRAME_COUNT,
  OpusFrameTtsProvider,
  createOpusFrameTtsProvider,
} from "../adapters/voice/src/index.ts";

test("LibopusFrameEncoder round-trips one 24 kHz / 60 ms mono frame", () => {
  const encoder = createLibopusFrameEncoder({ sampleRate: SERVER_SAMPLE_RATE_DEFAULT });
  try {
    assert.equal(encoder.sampleRate, 24000);
    assert.equal(encoder.frameDurationMs, OPUS_FRAME_DURATION_MS);
    assert.equal(encoder.channels, 1);
    const frameBytes = pcmBytesPerFrame(24000);
    assert.equal(frameBytes, 2880);
    const pcm = Buffer.alloc(frameBytes);
    for (let i = 0; i < frameBytes / 2; i += 1) {
      pcm.writeInt16LE(((i * 13) % 2000) - 1000, i * 2);
    }
    const packet = encoder.encodeFrame(pcm);
    assert.equal(isOpusPlaceholderPayload(packet), false);
    assert.equal(looksLikeRawOpusPacket(packet), true);
    assert.equal(packet.includes(OPUS_PLACEHOLDER_MAGIC), false);
    assert.ok(packet.byteLength > 0);
    assert.ok(encoder.decodeFrame);
    const decoded = encoder.decodeFrame!(packet);
    assert.equal(decoded.byteLength, frameBytes);
  } finally {
    encoder.destroy?.();
  }
});

test("LibopusFrameEncoder rejects wrong PCM frame size", () => {
  const encoder = createLibopusFrameEncoder({ sampleRate: 24000 });
  try {
    assert.throws(() => encoder.encodeFrame(Buffer.alloc(10)), /expects 2880/);
  } finally {
    encoder.destroy?.();
  }
});

test("placeholder helper still detects OB-OPUS-PLACEHOLDER", () => {
  const magic = Buffer.from(OPUS_PLACEHOLDER_MAGIC);
  assert.equal(isOpusPlaceholderPayload(magic), true);
  assert.equal(looksLikeRawOpusPacket(magic), false);
  const tagged = placeholderEncode(24000, Buffer.alloc(pcmBytesPerFrame(24000)));
  assert.equal(isOpusPlaceholderPayload(tagged.payload), true);
});

test("OpusFrameTtsProvider yields decodable non-placeholder Opus at hello rate", async () => {
  const encoder = createLibopusFrameEncoder({ sampleRate: 24000 });
  const tts = new OpusFrameTtsProvider({ encoder, frameCount: 3, pcmMode: "tone" });
  try {
    const packets: Buffer[] = [];
    for await (const packet of tts.synthesize("lab", { sampleRate: SERVER_SAMPLE_RATE_DEFAULT })) {
      packets.push(packet);
    }
    assert.equal(packets.length, 3);
    for (const packet of packets) {
      assert.equal(isOpusPlaceholderPayload(packet), false);
      assert.equal(looksLikeRawOpusPacket(packet), true);
      const decoded = encoder.decodeFrame!(packet);
      assert.equal(decoded.byteLength, pcmBytesPerFrame(24000));
    }
  } finally {
    tts.destroy();
  }
});

test("createOpusFrameTtsProvider default frame count matches mock history", async () => {
  const tts = createOpusFrameTtsProvider({ pcmMode: "silence" });
  const packets: Buffer[] = [];
  for await (const packet of tts.synthesize("x", { sampleRate: 24000 })) {
    packets.push(packet);
  }
  assert.equal(packets.length, MOCK_TTS_FRAME_COUNT);
  assert.equal(packets.every((p) => !isOpusPlaceholderPayload(p)), true);
  if ("destroy" in tts && typeof (tts as { destroy?: () => void }).destroy === "function") {
    (tts as { destroy: () => void }).destroy();
  }
});
