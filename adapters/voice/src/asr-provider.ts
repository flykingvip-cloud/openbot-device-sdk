/**
 * Injectable ASR for device adapters (metalio realtime + later record-card).
 * Implementations (FunASR SenseVoiceSmall, cloud vendors, etc.) live outside this package.
 * This SDK does not bundle model weights or hardcode a vendor.
 *
 * Dual mode (A3):
 * - Whole-utterance: WAV/PCM buffer → transcribe (WAV sampleRate/channels from header).
 * - Streaming: WS uplink chunks → stream() partial/final (stub usable in lab; real providers inject).
 */

export type AsrAudioFormat = "pcm" | "wav";

export interface AsrTranscribeOptions {
  sampleRate: number;
  channels: number;
  /**
   * When "wav", the buffer must be RIFF/WAVE; sampleRate/channels are taken from the fmt chunk
   * (see resolveAsrAudio). When omitted, RIFF/WAVE is still auto-detected; otherwise treat as PCM.
   */
  format?: AsrAudioFormat;
}

/**
 * Streaming shape for WS uplink (PCM/Opus/raw hint chunks → partial/final).
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
  /**
   * Optional per-chunk hint (lab / adapters). Real providers may ignore and decode data only.
   * sampleRate defaults to the session uplink rate when omitted.
   */
  sampleRate?: number;
  channels?: number;
}

export interface AsrProvider {
  /**
   * Whole-utterance transcription (WAV/PCM file or buffer).
   * Aligns with Claw4 upload and record-card post-capture paths.
   * Prefer resolveAsrAudio() so WAV headers supply sampleRate/channels.
   */
  transcribe(audio: Buffer, options: AsrTranscribeOptions): Promise<string>;

  /**
   * Streaming ASR: consume WS-shaped chunks, yield partial then final.
   * Lab MockAsrProvider implements a usable stub; production FunASR/etc. inject real decode.
   */
  stream?(chunks: AsyncIterable<AsrStreamChunk>): AsyncIterable<AsrStreamResult>;
}
