/**
 * Injectable ASR for device adapters (metalio realtime + later record-card).
 * Implementations (FunASR SenseVoiceSmall, cloud vendors, etc.) live outside this package.
 * This SDK does not bundle model weights or hardcode a vendor.
 */

export type AsrAudioFormat = "pcm" | "wav";

export interface AsrTranscribeOptions {
  sampleRate: number;
  channels: number;
  /** When omitted, treat the buffer as raw PCM (s16le). */
  format?: AsrAudioFormat;
}

/**
 * Streaming shape reserved for WS uplink (PCM/Opus chunks → partial/final).
 * A1 only stubs the type; implementations may throw until A3 wires it.
 */
export interface AsrPartialResult {
  partial: string;
  final?: undefined;
}

export interface AsrFinalResult {
  final: string;
  partial?: undefined;
}

export type AsrStreamResult = AsrPartialResult | AsrFinalResult;

export interface AsrStreamChunk {
  data: Buffer;
  /** End of utterance; provider should emit a final if it has one. */
  endOfUtterance?: boolean;
}

export interface AsrProvider {
  /**
   * Whole-utterance transcription (WAV/PCM file or buffer).
   * Aligns with Claw4 upload and record-card post-capture paths.
   */
  transcribe(audio: Buffer, options: AsrTranscribeOptions): Promise<string>;

  /**
   * Streaming stub. Default mock may reject; real providers implement later (A3).
   */
  stream?(chunks: AsyncIterable<AsrStreamChunk>): AsyncIterable<AsrStreamResult>;
}
