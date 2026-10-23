import {
  OPUS_FRAME_DURATION_MS,
  SERVER_SAMPLE_RATE_DEFAULT,
} from "../../metalio/src/constants.ts";
import {
  createLibopusFrameEncoder,
  type OpusFrameEncoder,
} from "../../metalio/src/opus-encoder.ts";
import { pcmBytesPerFrame, type OpusSampleRate } from "../../metalio/src/opus-boundary.ts";
import { MOCK_TTS_FRAME_COUNT } from "./mock.ts";
import type { TtsProvider, TtsSynthesizeOptions } from "./tts-provider.ts";

export type OpusTtsPcmMode = "silence" | "tone";

export interface OpusFrameTtsProviderOptions {
  /** Injected encoder; default is LibopusFrameEncoder at hello 24 kHz. */
  encoder?: OpusFrameEncoder;
  /** Number of Opus frames to emit; default matches historical mock count (8). */
  frameCount?: number;
  /** Lab PCM source before encode: silence or a soft 440 Hz tone. */
  pcmMode?: OpusTtsPcmMode;
  /** Tone amplitude for pcmMode=tone (int16 peak). */
  toneAmplitude?: number;
}

/**
 * Reference TtsProvider that yields **real** raw Opus packets (播报帧), not
 * OB-OPUS-PLACEHOLDER. Text is ignored for PCM content — inject EdgeTTS / etc.
 * for spoken audio; this path proves the metalio downlink is decodable Opus.
 */
export class OpusFrameTtsProvider implements TtsProvider {
  readonly frameCount: number;
  readonly pcmMode: OpusTtsPcmMode;
  readonly toneAmplitude: number;
  private readonly encoder: OpusFrameEncoder;
  private readonly ownsEncoder: boolean;

  constructor(options: OpusFrameTtsProviderOptions = {}) {
    this.ownsEncoder = options.encoder === undefined;
    this.encoder = options.encoder ?? createLibopusFrameEncoder({ sampleRate: SERVER_SAMPLE_RATE_DEFAULT });
    this.frameCount = options.frameCount ?? MOCK_TTS_FRAME_COUNT;
    this.pcmMode = options.pcmMode ?? "tone";
    this.toneAmplitude = options.toneAmplitude ?? 4_000;
  }

  async *synthesize(_text: string, options: TtsSynthesizeOptions): AsyncIterable<Buffer> {
    const sampleRate = options.sampleRate as OpusSampleRate;
    if (sampleRate !== this.encoder.sampleRate) {
      throw new Error(
        `OpusFrameTtsProvider encoder is ${this.encoder.sampleRate} Hz but synthesize requested ${sampleRate}`,
      );
    }
    if (this.encoder.frameDurationMs !== OPUS_FRAME_DURATION_MS) {
      throw new Error(`encoder frameDurationMs must be ${OPUS_FRAME_DURATION_MS}`);
    }
    const frameBytes = pcmBytesPerFrame(sampleRate);
    const samples = frameBytes / 2;
    for (let index = 0; index < this.frameCount; index += 1) {
      const pcm = Buffer.alloc(frameBytes);
      if (this.pcmMode === "tone") {
        fillToneFrame(pcm, sampleRate, samples, this.toneAmplitude, index);
      }
      yield this.encoder.encodeFrame(pcm);
    }
  }

  destroy(): void {
    if (this.ownsEncoder) {
      this.encoder.destroy?.();
    }
  }
}

export function createOpusFrameTtsProvider(options?: OpusFrameTtsProviderOptions): TtsProvider {
  return new OpusFrameTtsProvider(options);
}

function fillToneFrame(pcm: Buffer, sampleRate: number, samples: number, amplitude: number, frameIndex: number): void {
  const phase0 = (2 * Math.PI * 440 * frameIndex * samples) / sampleRate;
  for (let i = 0; i < samples; i += 1) {
    const sample = Math.sin(phase0 + (2 * Math.PI * 440 * i) / sampleRate) * amplitude;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample | 0)), i * 2);
  }
}
