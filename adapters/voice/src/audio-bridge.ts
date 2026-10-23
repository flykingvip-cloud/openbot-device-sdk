/**
 * Injectable audio bridge for claw4 / edge compat (Agent A P0).
 *
 * Contract (B may call later):
 * - wavBytes → AsrProvider.transcribe (no default pass-through transcript)
 * - assistantText → TtsProvider.synthesize → Opus frames (existing encoder path)
 * - cancel/abort handle for in-flight ASR/TTS
 *
 * Providers stay injectable; this module does not hardcode vendors or weights.
 *
 * IMPORTANT — OpusFrameTtsProvider is format/lab only: it ignores `text` and
 * emits fixed-count tone/silence Opus to prove the downlink path. A bridge
 * used for spoken TTS must inject a real TtsProvider (EdgeTTS, etc.) or the
 * reference {@link ProportionalSilenceTtsProvider} in tests (silence length
 * proportional to text — not a fixed tone pretending to be speech).
 */

import {
  OPUS_FRAME_DURATION_MS,
  SERVER_SAMPLE_RATE_DEFAULT,
} from "../../metalio/src/constants.ts";
import {
  createLibopusFrameEncoder,
  type OpusFrameEncoder,
} from "../../metalio/src/opus-encoder.ts";
import { pcmBytesPerFrame, type OpusSampleRate } from "../../metalio/src/opus-boundary.ts";
import { resolveAsrAudio } from "./asr-audio.ts";
import type { AsrProvider, AsrTranscribeOptions } from "./asr-provider.ts";
import type { TtsProvider, TtsSynthesizeOptions } from "./tts-provider.ts";

/** Default ASR options when WAV header is absent (should not happen for wavBytes). */
const DEFAULT_ASR_FALLBACK: AsrTranscribeOptions = {
  sampleRate: 16_000,
  channels: 1,
  format: "wav",
};

export interface AudioBridgeAbortHandle {
  /** Abort in-flight ASR/TTS started with this handle's signal. */
  abort(reason?: unknown): void;
  readonly signal: AbortSignal;
  readonly aborted: boolean;
}

export interface AudioBridgeOptions {
  asr: AsrProvider;
  /**
   * Must be a spoken (or test proportional-silence) TtsProvider.
   * Do not inject OpusFrameTtsProvider for product spoken TTS — it ignores text.
   */
  tts: TtsProvider;
  /** Default TTS sample rate; metalio hello default is 24000. */
  ttsSampleRate?: number;
}

export interface TranscribeWavOptions {
  signal?: AbortSignal;
  /** Override when buffer is raw PCM; WAV always takes sampleRate/channels from header. */
  asrOptions?: AsrTranscribeOptions;
}

export interface SynthesizeOpusOptions {
  sampleRate?: number;
  signal?: AbortSignal;
}

/**
 * Contract-first bridge: wav → ASR text; assistant text → Opus frames.
 * No default pass-through of query/header transcript — callers must use ASR.
 */
export interface AudioBridge {
  readonly asr: AsrProvider;
  readonly tts: TtsProvider;
  createAbortHandle(): AudioBridgeAbortHandle;
  /**
   * Whole-utterance WAV → AsrProvider.transcribe via resolveAsrAudio.
   * Rejects when signal is already aborted; does not invent a transcript.
   */
  transcribeWav(wavBytes: Buffer, options?: TranscribeWavOptions): Promise<string>;
  /**
   * assistantText → TtsProvider.synthesize → Opus frame buffers.
   * Stops yielding when signal aborts (best-effort; provider may still finish a frame).
   */
  synthesizeOpus(assistantText: string, options?: SynthesizeOpusOptions): AsyncIterable<Buffer>;
}

export class InjectableAudioBridge implements AudioBridge {
  readonly asr: AsrProvider;
  readonly tts: TtsProvider;
  private readonly ttsSampleRate: number;

  constructor(options: AudioBridgeOptions) {
    this.asr = options.asr;
    this.tts = options.tts;
    this.ttsSampleRate = options.ttsSampleRate ?? SERVER_SAMPLE_RATE_DEFAULT;
  }

  createAbortHandle(): AudioBridgeAbortHandle {
    const controller = new AbortController();
    return {
      abort(reason?: unknown): void {
        controller.abort(reason);
      },
      get signal(): AbortSignal {
        return controller.signal;
      },
      get aborted(): boolean {
        return controller.signal.aborted;
      },
    };
  }

  async transcribeWav(wavBytes: Buffer, options: TranscribeWavOptions = {}): Promise<string> {
    throwIfAborted(options.signal);
    const resolved = resolveAsrAudio(wavBytes, options.asrOptions ?? DEFAULT_ASR_FALLBACK);
    throwIfAborted(options.signal);
    const text = await this.asr.transcribe(resolved.audio, resolved.options);
    throwIfAborted(options.signal);
    return text;
  }

  async *synthesizeOpus(assistantText: string, options: SynthesizeOpusOptions = {}): AsyncIterable<Buffer> {
    throwIfAborted(options.signal);
    const sampleRate = options.sampleRate ?? this.ttsSampleRate;
    const synthesizeOptions: TtsSynthesizeOptions = { sampleRate };
    for await (const frame of this.tts.synthesize(assistantText, synthesizeOptions)) {
      throwIfAborted(options.signal);
      yield frame;
    }
  }
}

export function createAudioBridge(options: AudioBridgeOptions): AudioBridge {
  return new InjectableAudioBridge(options);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    const error = new Error("AudioBridge operation aborted");
    error.name = "AbortError";
    throw error;
  }
}

export interface ProportionalSilenceTtsProviderOptions {
  /** Injected encoder; default LibopusFrameEncoder at hello 24 kHz. */
  encoder?: OpusFrameEncoder;
  /**
   * Milliseconds of silence per UTF-16 code unit (approx char).
   * Default 40 ms/char → "hi" ≈ 80 ms → at least one 60 ms frame.
   */
  msPerChar?: number;
  /** Minimum frames even for empty text (still non-empty path when text length > 0). */
  minFrames?: number;
  /** Cap frames so lab tests stay bounded. */
  maxFrames?: number;
}

/**
 * Reference / test TtsProvider: maps text → silence PCM of length proportional
 * to text, then encodes via the existing Opus frame encoder path.
 * NOT a fixed tone pretending to be speech (contrast OpusFrameTtsProvider).
 * Empty text yields zero frames (callers should not speak empty assistant text).
 */
export class ProportionalSilenceTtsProvider implements TtsProvider {
  readonly msPerChar: number;
  readonly minFrames: number;
  readonly maxFrames: number;
  private readonly encoder: OpusFrameEncoder;
  private readonly ownsEncoder: boolean;

  constructor(options: ProportionalSilenceTtsProviderOptions = {}) {
    this.ownsEncoder = options.encoder === undefined;
    this.encoder = options.encoder ?? createLibopusFrameEncoder({ sampleRate: SERVER_SAMPLE_RATE_DEFAULT });
    this.msPerChar = options.msPerChar ?? 40;
    this.minFrames = options.minFrames ?? 1;
    this.maxFrames = options.maxFrames ?? 200;
  }

  async *synthesize(text: string, options: TtsSynthesizeOptions): AsyncIterable<Buffer> {
    if (text.length === 0) {
      return;
    }
    const sampleRate = options.sampleRate as OpusSampleRate;
    if (sampleRate !== this.encoder.sampleRate) {
      throw new Error(
        `ProportionalSilenceTtsProvider encoder is ${this.encoder.sampleRate} Hz but synthesize requested ${sampleRate}`,
      );
    }
    if (this.encoder.frameDurationMs !== OPUS_FRAME_DURATION_MS) {
      throw new Error(`encoder frameDurationMs must be ${OPUS_FRAME_DURATION_MS}`);
    }
    const durationMs = Math.max(this.msPerChar * text.length, this.minFrames * OPUS_FRAME_DURATION_MS);
    let frameCount = Math.ceil(durationMs / OPUS_FRAME_DURATION_MS);
    frameCount = Math.max(this.minFrames, Math.min(this.maxFrames, frameCount));
    const frameBytes = pcmBytesPerFrame(sampleRate);
    for (let index = 0; index < frameCount; index += 1) {
      // Silence PCM — length (frame count) tracks text; content is not a speech tone.
      const pcm = Buffer.alloc(frameBytes);
      yield this.encoder.encodeFrame(pcm);
    }
  }

  destroy(): void {
    if (this.ownsEncoder) {
      this.encoder.destroy?.();
    }
  }
}

export function createProportionalSilenceTtsProvider(
  options?: ProportionalSilenceTtsProviderOptions,
): TtsProvider {
  return new ProportionalSilenceTtsProvider(options);
}
