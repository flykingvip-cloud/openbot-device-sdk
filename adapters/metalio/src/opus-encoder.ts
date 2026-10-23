import { Decoder, Encoder } from "@evan/opus";

import {
  OPUS_FRAME_DURATION_MS,
  SERVER_SAMPLE_RATE_DEFAULT,
  UPLINK_CHANNELS,
} from "./constants.ts";
import { OPUS_PLACEHOLDER_MAGIC, OpusBoundaryError, pcmBytesPerFrame, type OpusSampleRate } from "./opus-boundary.ts";

/**
 * One metalio broadcast (播报) Opus frame at a fixed hello sample rate.
 * Implementations must not talk to api.tenclass.net.
 */
export interface OpusFrameEncoder {
  readonly sampleRate: OpusSampleRate;
  readonly channels: typeof UPLINK_CHANNELS;
  readonly frameDurationMs: typeof OPUS_FRAME_DURATION_MS;
  /** Encode one s16le mono PCM frame → one raw Opus packet (not Ogg). */
  encodeFrame(pcmS16le: Uint8Array): Buffer;
  /** Optional decoder for lab round-trip checks. */
  decodeFrame?(packet: Uint8Array): Buffer;
  destroy?(): void;
}

export interface CreateLibopusFrameEncoderOptions {
  sampleRate?: OpusSampleRate;
  /** Opus application; voip matches speech downlink. */
  application?: "voip" | "audio" | "restricted_lowdelay";
  /** Target bitrate in bits/s; default 24 kbps for mono speech. */
  bitrate?: number;
}

/**
 * True when a downlink Buffer is still the lab mock magic (not playable Opus).
 */
export function isOpusPlaceholderPayload(payload: Uint8Array): boolean {
  const magic = Buffer.from(OPUS_PLACEHOLDER_MAGIC, "utf8");
  if (payload.byteLength < magic.byteLength) {
    return false;
  }
  return Buffer.from(payload.subarray(0, magic.byteLength)).equals(magic);
}

/**
 * Cheap structural check: not placeholder, non-empty, and first byte looks like an Opus TOC.
 * Does not prove decodability — prefer encode/decode round-trip in tests.
 */
export function looksLikeRawOpusPacket(payload: Uint8Array): boolean {
  if (payload.byteLength === 0 || isOpusPlaceholderPayload(payload)) {
    return false;
  }
  // RFC 6716 §3.1: config in high 5 bits of TOC; reject all-zero empty-ish payloads only by length above.
  const toc = payload[0]!;
  const config = toc >> 3;
  return config <= 31;
}

/**
 * libopus via `@evan/opus` (native prebuilds when available, else WASM).
 * Set `OPUS_FORCE_WASM=1` to force the WASM path (useful in CI).
 * Produces **播报帧 Opus** (metalio realtime downlink), not recording-store Opus.
 */
export class LibopusFrameEncoder implements OpusFrameEncoder {
  readonly sampleRate: OpusSampleRate;
  readonly channels = UPLINK_CHANNELS;
  readonly frameDurationMs = OPUS_FRAME_DURATION_MS;

  private readonly encoder: Encoder;
  private readonly decoder: Decoder;
  private readonly frameBytes: number;

  constructor(options: CreateLibopusFrameEncoderOptions = {}) {
    const sampleRate = options.sampleRate ?? SERVER_SAMPLE_RATE_DEFAULT;
    if (sampleRate !== 16000 && sampleRate !== 24000) {
      throw new OpusBoundaryError(`unsupported Opus sample rate ${sampleRate}`);
    }
    this.sampleRate = sampleRate;
    this.frameBytes = pcmBytesPerFrame(sampleRate);
    this.encoder = new Encoder({
      channels: 1,
      sample_rate: sampleRate,
      application: options.application ?? "voip",
    });
    // Prefer explicit 60 ms frames to match metalio hello / OPUS_FRAME_DURATION_MS.
    // Do not read expert_frame_duration (native getter bug in @evan/opus@1.0.3).
    this.encoder.expert_frame_duration = OPUS_FRAME_DURATION_MS;
    this.encoder.bitrate = options.bitrate ?? 24_000;
    this.encoder.signal = "voice";
    this.decoder = new Decoder({ channels: 1, sample_rate: sampleRate });
  }

  encodeFrame(pcmS16le: Uint8Array): Buffer {
    if (pcmS16le.byteLength !== this.frameBytes) {
      throw new OpusBoundaryError(
        `Opus frame expects ${this.frameBytes} PCM bytes for ${this.sampleRate} Hz / ${OPUS_FRAME_DURATION_MS} ms, got ${pcmS16le.byteLength}`,
      );
    }
    const samples = pcmS16le.byteLength / 2;
    const pcm = new Int16Array(samples);
    const view = Buffer.from(pcmS16le.buffer, pcmS16le.byteOffset, pcmS16le.byteLength);
    for (let index = 0; index < samples; index += 1) {
      pcm[index] = view.readInt16LE(index * 2);
    }
    const packet = this.encoder.encode(pcm);
    return Buffer.from(packet);
  }

  decodeFrame(packet: Uint8Array): Buffer {
    const pcm = this.decoder.decode(packet);
    return Buffer.from(pcm);
  }

  destroy(): void {
    this.encoder.reset();
    this.decoder.reset();
  }
}

export function createLibopusFrameEncoder(options?: CreateLibopusFrameEncoderOptions): OpusFrameEncoder {
  return new LibopusFrameEncoder(options);
}
