import { OPUS_FRAME_DURATION_MS, UPLINK_CHANNELS, UPLINK_SAMPLE_RATE } from "./constants.ts";

/**
 * Marker prefix so a placeholder packet cannot be mistaken for an Opus TOC byte.
 * This package does not link libopus.
 */
export const OPUS_PLACEHOLDER_MAGIC = "OB-OPUS-PLACEHOLDER";

export type OpusSampleRate = 16000 | 24000;

export interface OpusPlaceholderFrame {
  format: "opus";
  placeholder: true;
  sampleRate: OpusSampleRate;
  channels: typeof UPLINK_CHANNELS;
  frameDurationMs: typeof OPUS_FRAME_DURATION_MS;
  pcmByteLength: number;
  payload: Uint8Array;
}

export class OpusBoundaryError extends Error {
  readonly code = "opus_boundary";

  constructor(message: string) {
    super(message);
    this.name = "OpusBoundaryError";
  }
}

export function pcmBytesPerFrame(sampleRate: OpusSampleRate): number {
  return (sampleRate * OPUS_FRAME_DURATION_MS) / 1000 * 2;
}

/**
 * Accepts one PCM frame and returns a tagged payload.
 * The payload is not an Opus packet and must not be played as one.
 */
export function placeholderEncode(sampleRate: OpusSampleRate, pcm: Uint8Array): OpusPlaceholderFrame {
  const expected = pcmBytesPerFrame(sampleRate);
  if (pcm.byteLength !== expected) {
    throw new OpusBoundaryError(`placeholder boundary expects ${expected} PCM bytes for ${sampleRate} Hz, got ${pcm.byteLength}`);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(pcm.byteLength, 0);
  const payload = Buffer.concat([Buffer.from(`${OPUS_PLACEHOLDER_MAGIC}\0`, "utf8"), length]);
  return {
    format: "opus",
    placeholder: true,
    sampleRate,
    channels: UPLINK_CHANNELS,
    frameDurationMs: OPUS_FRAME_DURATION_MS,
    pcmByteLength: pcm.byteLength,
    payload,
  };
}

export function readPlaceholder(frame: OpusPlaceholderFrame): { pcmByteLength: number } {
  if (frame.placeholder !== true || frame.frameDurationMs !== OPUS_FRAME_DURATION_MS || frame.channels !== 1) {
    throw new OpusBoundaryError("frame is outside the opus placeholder boundary");
  }
  const magic = Buffer.from(`${OPUS_PLACEHOLDER_MAGIC}\0`, "utf8");
  const payload = Buffer.from(frame.payload);
  if (payload.length !== magic.length + 4 || !payload.subarray(0, magic.length).equals(magic)) {
    throw new OpusBoundaryError("payload is not an opus placeholder");
  }
  const pcmByteLength = payload.readUInt32BE(magic.length);
  if (pcmByteLength !== frame.pcmByteLength || pcmByteLength !== pcmBytesPerFrame(frame.sampleRate)) {
    throw new OpusBoundaryError("placeholder length does not match the frame boundary");
  }
  return { pcmByteLength };
}
