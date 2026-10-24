/**
 * Uplink Opus → PCM helpers (P1-2).
 *
 * Metalio hello uplink is bare Opus packets at 16 kHz / mono / 60 ms.
 * Packet boundaries must be preserved; lab must not label Opus bytes as PCM.
 *
 * Two consumption modes:
 * - Decode here → feed existing PCM ASR (`wrapAsrProviderWithOpusDecode`, Mock/reference stream).
 * - Inject a codec-aware AsrProvider that reads `AsrStreamChunk.codec === "opus"` directly
 *   (do not wrap that provider).
 */

import { UPLINK_SAMPLE_RATE } from "../../metalio/src/constants.ts";
import type { OpusSampleRate } from "../../metalio/src/opus-boundary.ts";
import {
  createLibopusFrameEncoder,
  looksLikeRawOpusPacket,
  type OpusFrameEncoder,
} from "../../metalio/src/opus-encoder.ts";
import type {
  AsrProvider,
  AsrStreamChunk,
  AsrStreamResult,
  AsrTranscribeOptions,
  AsrUplinkCodec,
} from "./asr-provider.ts";

export interface OpusUplinkDecoder {
  readonly sampleRate: OpusSampleRate;
  /** Decode one raw Opus packet → s16le mono PCM. Preserves one packet → one frame. */
  decodePacket(packet: Uint8Array): Buffer;
  destroy(): void;
}

export interface CreateOpusUplinkDecoderOptions {
  /** Default metalio uplink 16 kHz. */
  sampleRate?: OpusSampleRate;
}

/**
 * Thin libopus decoder for ASR uplink packets (reuses LibopusFrameEncoder.decodeFrame).
 */
export function createOpusUplinkDecoder(
  options: CreateOpusUplinkDecoderOptions = {},
): OpusUplinkDecoder {
  const sampleRate = options.sampleRate ?? (UPLINK_SAMPLE_RATE as OpusSampleRate);
  const encoder: OpusFrameEncoder = createLibopusFrameEncoder({ sampleRate });
  if (typeof encoder.decodeFrame !== "function") {
    encoder.destroy?.();
    throw new Error("Opus uplink decoder requires decodeFrame on the frame encoder");
  }
  return {
    sampleRate,
    decodePacket(packet: Uint8Array): Buffer {
      if (packet.byteLength === 0) {
        return Buffer.alloc(0);
      }
      return encoder.decodeFrame!(packet);
    },
    destroy(): void {
      encoder.destroy?.();
    },
  };
}

export function resolveAsrStreamCodec(chunk: AsrStreamChunk): AsrUplinkCodec {
  return chunk.codec ?? chunk.format ?? "pcm";
}

/**
 * True when collected uplink packets should be labeled opus (not PCM).
 * WAV whole-utterance buffers are handled separately via isWavBuffer.
 */
export function uplinkPacketsLookLikeOpus(packets: readonly Buffer[]): boolean {
  if (packets.length === 0) {
    return false;
  }
  let opusHits = 0;
  for (const packet of packets) {
    if (packet.byteLength === 0) {
      continue;
    }
    if (looksLikeRawOpusPacket(packet)) {
      opusHits += 1;
    }
  }
  return opusHits > 0 && opusHits >= Math.ceil(packets.filter((p) => p.byteLength > 0).length / 2);
}

/**
 * Map packet buffers to AsrStreamChunk with preserved boundaries and an explicit codec.
 * The last non-empty (or last) chunk gets endOfUtterance.
 */
export async function* packetsToAsrStreamChunks(
  packets: readonly Buffer[],
  options: {
    sampleRate: number;
    channels: number;
    codec: AsrUplinkCodec;
  },
): AsyncIterable<AsrStreamChunk> {
  if (packets.length === 0) {
    yield {
      data: Buffer.alloc(0),
      sampleRate: options.sampleRate,
      channels: options.channels,
      codec: options.codec,
      format: options.codec,
      endOfUtterance: true,
    };
    return;
  }
  for (let index = 0; index < packets.length; index += 1) {
    const data = packets[index]!;
    const isLast = index === packets.length - 1;
    yield {
      data,
      sampleRate: options.sampleRate,
      channels: options.channels,
      codec: options.codec,
      format: options.codec,
      endOfUtterance: isLast,
    };
  }
}

/**
 * Drain AsrProvider.stream and return the final transcript (or last partial).
 */
export async function finalTranscriptFromStream(
  asr: AsrProvider,
  chunks: AsyncIterable<AsrStreamChunk>,
): Promise<string> {
  if (typeof asr.stream !== "function") {
    throw new Error("AsrProvider.stream is not implemented");
  }
  let finalText: string | undefined;
  let lastPartial = "";
  for await (const item of asr.stream(chunks)) {
    if ("final" in item && item.final !== undefined) {
      finalText = item.final;
    } else if ("partial" in item && item.partial !== undefined) {
      lastPartial = item.partial;
    }
  }
  if (finalText !== undefined) {
    return finalText;
  }
  return lastPartial;
}

export interface WrapAsrProviderWithOpusDecodeOptions {
  sampleRate?: OpusSampleRate;
}

/**
 * Wrap a PCM-oriented AsrProvider so `stream()` accepts codec:"opus" chunks:
 * decode packet → PCM → forward to inner.stream (or accumulate + transcribe).
 *
 * Do **not** wrap a codec-aware Provider that already consumes Opus packet
 * boundaries — inject that Provider directly instead.
 */
export function wrapAsrProviderWithOpusDecode(
  inner: AsrProvider,
  options: WrapAsrProviderWithOpusDecodeOptions = {},
): AsrProvider {
  const sampleRate = options.sampleRate ?? (UPLINK_SAMPLE_RATE as OpusSampleRate);
  return {
    transcribe(audio: Buffer, transcribeOptions: AsrTranscribeOptions): Promise<string> {
      return inner.transcribe(audio, transcribeOptions);
    },
    async *stream(chunks: AsyncIterable<AsrStreamChunk>): AsyncIterable<AsrStreamResult> {
      const decoder = createOpusUplinkDecoder({ sampleRate });
      try {
        if (typeof inner.stream === "function") {
          yield* inner.stream(decodeOpusChunksToPcm(chunks, decoder));
          return;
        }
        let pcmAcc = Buffer.alloc(0);
        let rate = sampleRate;
        let channels = 1;
        for await (const chunk of decodeOpusChunksToPcm(chunks, decoder)) {
          if (chunk.sampleRate !== undefined) {
            rate = chunk.sampleRate as OpusSampleRate;
          }
          if (chunk.channels !== undefined) {
            channels = chunk.channels;
          }
          if (chunk.data.byteLength > 0) {
            pcmAcc = Buffer.concat([pcmAcc, chunk.data]);
          }
          if (chunk.endOfUtterance) {
            break;
          }
        }
        const text = await inner.transcribe(pcmAcc, { sampleRate: rate, channels, format: "pcm" });
        yield { final: text };
      } finally {
        decoder.destroy();
      }
    },
  };
}

async function* decodeOpusChunksToPcm(
  chunks: AsyncIterable<AsrStreamChunk>,
  decoder: OpusUplinkDecoder,
): AsyncIterable<AsrStreamChunk> {
  for await (const chunk of chunks) {
    const codec = resolveAsrStreamCodec(chunk);
    if (codec !== "opus") {
      yield chunk;
      continue;
    }
    // Decode Opus → PCM; never forward raw Opus labeled as pcm.
    const pcm =
      chunk.data.byteLength === 0 ? Buffer.alloc(0) : decoder.decodePacket(chunk.data);
    const out: AsrStreamChunk = {
      data: pcm,
      sampleRate: chunk.sampleRate ?? decoder.sampleRate,
      channels: chunk.channels ?? 1,
      codec: "pcm",
      format: "pcm",
    };
    if (chunk.endOfUtterance !== undefined) {
      out.endOfUtterance = chunk.endOfUtterance;
    }
    yield out;
  }
}
