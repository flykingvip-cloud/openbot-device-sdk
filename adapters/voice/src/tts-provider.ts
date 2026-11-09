/**
 * Injectable TTS for device adapters.
 * Implementations (EdgeTTS, local engines, etc.) live outside this package.
 * Downlink sample rate follows metalio server hello (lab sends 16 kHz mono / 60 ms).
 * Returned buffers are Opus packets when a real encoder is injected;
 * the lab mock yields OB-OPUS-PLACEHOLDER frames (not playable Opus).
 */

export interface TtsSynthesizeOptions {
  /** Target Opus sample rate; lab Metalio hello sends 16000. */
  sampleRate: number;
}

export interface TtsProvider {
  /**
   * Synthesize speech as an async sequence of Opus packets (one frame each).
   * Callers send each Buffer as a binary WS downlink frame.
   */
  synthesize(text: string, options: TtsSynthesizeOptions): AsyncIterable<Buffer>;
}
