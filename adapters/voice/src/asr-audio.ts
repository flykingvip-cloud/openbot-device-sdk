/**
 * Whole-utterance ASR input normalization.
 * When the buffer is WAV (or format:"wav"), sampleRate/channels come from the
 * file header; callers may still pass PCM with explicit options.
 */

import type { AsrTranscribeOptions } from "./asr-provider.ts";
import { isWavBuffer, parseWavPcm } from "./wav.ts";

export interface ResolvedAsrAudio {
  /** Original buffer (WAV container or raw PCM / lab hint). */
  audio: Buffer;
  /** Options with sampleRate/channels filled from the WAVE fmt chunk when present. */
  options: AsrTranscribeOptions;
  /** True when audio is a RIFF/WAVE container. */
  isWav: boolean;
  /** PCM payload when WAV was parsed; undefined for raw PCM / hint buffers. */
  pcm?: Buffer;
}

/**
 * Resolve ASR options for a whole-utterance buffer.
 * - format "wav" or auto-detected RIFF/WAVE → parse header; override sampleRate/channels.
 * - otherwise → keep caller sampleRate/channels (raw PCM or lab UTF-8 hints).
 */
export function resolveAsrAudio(audio: Buffer, options: AsrTranscribeOptions): ResolvedAsrAudio {
  const looksWav = isWavBuffer(audio);
  if (options.format === "wav" || looksWav) {
    if (!looksWav) {
      throw new Error("AsrTranscribeOptions.format is wav but buffer is not RIFF/WAVE");
    }
    const wav = parseWavPcm(audio);
    return {
      audio,
      isWav: true,
      pcm: wav.pcm,
      options: {
        sampleRate: wav.sampleRate,
        channels: wav.channels,
        format: "wav",
      },
    };
  }
  return {
    audio,
    isWav: false,
    options: {
      sampleRate: options.sampleRate,
      channels: options.channels,
      format: options.format ?? "pcm",
    },
  };
}
