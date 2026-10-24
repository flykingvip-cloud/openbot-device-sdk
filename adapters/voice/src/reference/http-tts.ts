/**
 * Optional EdgeTTS-shaped HTTP TTS reference adapter (P1-1).
 *
 * POSTs `{ text, voice?, sampleRate }` to a caller-configured URL, expects
 * WAV or raw PCM (s16le mono) back, then encodes 60 ms frames with the
 * existing OpusFrameEncoder path. Compatible with a local EdgeTTS HTTP
 * wrapper — host / voice / headers all come from config; nothing vendor-
 * specific is hardcoded.
 *
 * Product spoken TTS must use this (or another real TtsProvider), NOT
 * OpusFrameTtsProvider (lab/format only; ignores text).
 */

import {
  OPUS_FRAME_DURATION_MS,
  SERVER_SAMPLE_RATE_DEFAULT,
} from "../../../metalio/src/constants.ts";
import {
  createLibopusFrameEncoder,
  type OpusFrameEncoder,
} from "../../../metalio/src/opus-encoder.ts";
import { pcmBytesPerFrame, type OpusSampleRate } from "../../../metalio/src/opus-boundary.ts";
import { isWavBuffer, parseWavPcm } from "../wav.ts";
import type { TtsProvider, TtsSynthesizeOptions } from "../tts-provider.ts";
import type { ReferenceHttpTtsConfig } from "./config.ts";
import type { FetchLike } from "./http-asr.ts";

export interface ReferenceHttpTtsProviderOptions extends ReferenceHttpTtsConfig {
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected encoder; default LibopusFrameEncoder at hello 24 kHz. */
  encoder?: OpusFrameEncoder;
}

function pcmFromResponseBody(body: Buffer, requestedSampleRate: number): {
  pcm: Buffer;
  sampleRate: number;
} {
  if (isWavBuffer(body)) {
    const wav = parseWavPcm(body);
    if (wav.channels !== 1) {
      throw new Error(`ReferenceHttpTtsProvider: expected mono WAV, got ${wav.channels} channels`);
    }
    if (wav.bitsPerSample !== 16) {
      throw new Error(`ReferenceHttpTtsProvider: expected 16-bit PCM WAV, got ${wav.bitsPerSample}`);
    }
    return { pcm: wav.pcm, sampleRate: wav.sampleRate };
  }
  // Raw s16le mono at the synthesize target rate.
  if (body.byteLength % 2 !== 0) {
    throw new Error("ReferenceHttpTtsProvider: raw PCM body length must be even (s16le)");
  }
  return { pcm: body, sampleRate: requestedSampleRate };
}

/**
 * HTTP → PCM/WAV → Opus frame TtsProvider.
 * Empty text yields zero frames (same convention as ProportionalSilenceTtsProvider).
 */
export class ReferenceHttpTtsProvider implements TtsProvider {
  readonly url: string;
  readonly voice: string | undefined;
  readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly encoder: OpusFrameEncoder;
  private readonly ownsEncoder: boolean;

  constructor(options: ReferenceHttpTtsProviderOptions) {
    if (!options.url || options.url.trim().length === 0) {
      throw new Error("ReferenceHttpTtsProvider requires options.url from config/env");
    }
    this.url = options.url.trim();
    this.voice = options.voice?.trim() || undefined;
    this.headers = { ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ownsEncoder = options.encoder === undefined;
    this.encoder = options.encoder ?? createLibopusFrameEncoder({ sampleRate: SERVER_SAMPLE_RATE_DEFAULT });
  }

  async *synthesize(text: string, options: TtsSynthesizeOptions): AsyncIterable<Buffer> {
    if (text.length === 0) {
      return;
    }
    const sampleRate = options.sampleRate as OpusSampleRate;
    if (sampleRate !== this.encoder.sampleRate) {
      throw new Error(
        `ReferenceHttpTtsProvider encoder is ${this.encoder.sampleRate} Hz but synthesize requested ${sampleRate}`,
      );
    }
    if (this.encoder.frameDurationMs !== OPUS_FRAME_DURATION_MS) {
      throw new Error(`encoder frameDurationMs must be ${OPUS_FRAME_DURATION_MS}`);
    }

    const body: Record<string, unknown> = {
      text,
      sampleRate,
    };
    if (this.voice !== undefined) {
      body.voice = this.voice;
    }

    const headers: Record<string, string> = {
      Accept: "audio/wav, application/octet-stream",
      "Content-Type": "application/json",
      ...this.headers,
    };

    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `ReferenceHttpTtsProvider HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    const raw = Buffer.from(arrayBuffer);
    const { pcm, sampleRate: pcmRate } = pcmFromResponseBody(raw, sampleRate);
    if (pcmRate !== sampleRate) {
      throw new Error(
        `ReferenceHttpTtsProvider: response sampleRate ${pcmRate} != requested ${sampleRate} (resample outside SDK)`,
      );
    }

    const frameBytes = pcmBytesPerFrame(sampleRate);
    if (pcm.byteLength === 0) {
      return;
    }
    let offset = 0;
    while (offset < pcm.byteLength) {
      const slice = pcm.subarray(offset, offset + frameBytes);
      offset += frameBytes;
      if (slice.byteLength === frameBytes) {
        yield this.encoder.encodeFrame(slice);
      } else {
        // Pad final short frame with silence so libopus gets a full frame.
        const padded = Buffer.alloc(frameBytes);
        slice.copy(padded);
        yield this.encoder.encodeFrame(padded);
      }
    }
  }

  destroy(): void {
    if (this.ownsEncoder) {
      this.encoder.destroy?.();
    }
  }
}

export function createReferenceHttpTtsProvider(
  options: ReferenceHttpTtsProviderOptions,
): TtsProvider {
  return new ReferenceHttpTtsProvider(options);
}
