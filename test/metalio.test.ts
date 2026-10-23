import assert from "node:assert/strict";
import test from "node:test";

import {
  ABORT_RESIDUAL_MS,
  FIRMWARE_SHA,
  MAX_DECODE_PACKETS_IN_QUEUE,
  MetalioAbortResidual,
  OPUS_PLACEHOLDER_MAGIC,
  buildClientHello,
  buildWebsocketHeaders,
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseServerHello,
  pcmBytesPerFrame,
  placeholderEncode,
  readPlaceholder,
} from "../adapters/metalio/src/index.ts";

test("firmware pin and client hello match the Metalio baseline", () => {
  assert.equal(FIRMWARE_SHA, "ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950");
  assert.deepEqual(buildClientHello(), {
    type: "hello",
    version: 1,
    features: { mcp: true },
    transport: "websocket",
    audio_params: {
      format: "opus",
      sample_rate: 16000,
      channels: 1,
      frame_duration: 60,
    },
  });
  const hello = parseServerHello({
    type: "hello",
    transport: "websocket",
    session_id: "sess_1",
    audio_params: { sample_rate: 24000, frame_duration: 60 },
  });
  assert.equal(hello.sessionId, "sess_1");
  assert.equal(hello.sampleRate, 24000);
  assert.throws(() => parseServerHello({ type: "hello", transport: "udp" }), /websocket/);
});

test("websocket headers add Bearer only when the token has no space", () => {
  const headers = buildWebsocketHeaders({
    deviceId: "aa:bb",
    clientId: "uuid-1",
    token: "lab-token",
    protocolVersion: 1,
  });
  assert.equal(headers.Authorization, "Bearer lab-token");
  assert.equal(headers["Protocol-Version"], "1");
  assert.equal(headers["Device-Id"], "aa:bb");
  assert.equal(headers["Client-Id"], "uuid-1");
  const prefixed = buildWebsocketHeaders({
    deviceId: "aa:bb",
    clientId: "uuid-1",
    token: "Bearer already",
  });
  assert.equal(prefixed.Authorization, "Bearer already");
});

test("binary frames round-trip for protocol versions 1, 2, and 3", () => {
  const payload = Uint8Array.from([1, 2, 3, 4]);
  assert.deepEqual(decodeBinaryFrame(1, encodeBinaryFrame({ version: 1, payload, timestamp: 0 })).payload, payload);
  const v2 = encodeBinaryFrame({ version: 2, payload, timestamp: 60 });
  assert.equal(v2.length, 20);
  assert.equal(v2.readUInt16BE(0), 2);
  assert.equal(v2.readUInt32BE(8), 60);
  assert.deepEqual(decodeBinaryFrame(2, v2).payload, payload);
  const v3 = encodeBinaryFrame({ version: 3, payload, timestamp: 0 });
  assert.equal(v3.length, 8);
  assert.equal(v3.readUInt16BE(2), 4);
  assert.deepEqual(decodeBinaryFrame(3, v3).payload, payload);
});

test("opus placeholder marks a 60 ms boundary and is not a codec packet", () => {
  const pcm = new Uint8Array(pcmBytesPerFrame(16000));
  const frame = placeholderEncode(16000, pcm);
  assert.equal(frame.placeholder, true);
  assert.equal(frame.frameDurationMs, 60);
  assert.equal(readPlaceholder(frame).pcmByteLength, 1920);
  assert.equal(Buffer.from(frame.payload.subarray(0, OPUS_PLACEHOLDER_MAGIC.length)).toString("utf8"), OPUS_PLACEHOLDER_MAGIC);
  assert.throws(() => placeholderEncode(16000, new Uint8Array(10)), /boundary/);
});

test("metalio-faithful abort leaves up to 2400 ms in the decode queue", () => {
  const playback = new MetalioAbortResidual();
  playback.ttsStart();
  assert.equal(playback.state, "speaking");
  const packet = Uint8Array.from([9]);
  for (let i = 0; i < MAX_DECODE_PACKETS_IN_QUEUE; i += 1) {
    assert.equal(playback.enqueueDownlink(packet), "queued");
  }
  assert.equal(MAX_DECODE_PACKETS_IN_QUEUE, 40);
  assert.equal(playback.residualMs(), ABORT_RESIDUAL_MS);
  assert.equal(ABORT_RESIDUAL_MS, 2400);
  const wire = playback.abortSpeaking("sess_1", "wake_word_detected");
  assert.equal(wire, '{"session_id":"sess_1","type":"abort","reason":"wake_word_detected"}');
  assert.equal(playback.aborted, true);
  assert.equal(playback.depth, 40);
  assert.equal(playback.residualMs(), 2400);
  assert.equal(playback.enqueueDownlink(packet), "blocked");
  playback.ttsStart();
  assert.equal(playback.aborted, false);
  assert.equal(playback.depth, 40);
  playback.ttsStop(false);
  assert.equal(playback.state, "listening");
  playback.ttsStart();
  assert.equal(playback.depth, 0);
  const idle = new MetalioAbortResidual();
  assert.equal(idle.enqueueDownlink(packet), "dropped");
});

test("abort clear-on-abort resets decode queue (real TTS product path)", () => {
  const playback = new MetalioAbortResidual({ abortDecodePolicy: "clear-on-abort" });
  playback.ttsStart();
  const packet = Uint8Array.from([9]);
  for (let i = 0; i < MAX_DECODE_PACKETS_IN_QUEUE; i += 1) {
    assert.equal(playback.enqueueDownlink(packet), "queued");
  }
  assert.equal(playback.residualMs(), ABORT_RESIDUAL_MS);
  const wire = playback.abortSpeaking("sess_1", "wake_word_detected");
  assert.equal(wire, '{"session_id":"sess_1","type":"abort","reason":"wake_word_detected"}');
  assert.equal(playback.aborted, true);
  assert.equal(playback.depth, 0);
  assert.equal(playback.residualMs(), 0);
  assert.equal(playback.enqueueDownlink(packet), "dropped");
  playback.ttsStart();
  assert.equal(playback.aborted, false);
  assert.equal(playback.enqueueDownlink(packet), "queued");
  assert.equal(playback.depth, 1);
});
