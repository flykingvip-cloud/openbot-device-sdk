import { OPUS_PLACEHOLDER_MAGIC } from "../../metalio/src/opus-boundary.ts";
import { resolveAsrAudio } from "./asr-audio.ts";
import type { AsrProvider, AsrStreamChunk, AsrStreamResult, AsrTranscribeOptions } from "./asr-provider.ts";
import type { TtsProvider, TtsSynthesizeOptions } from "./tts-provider.ts";

/** Matches historical lab-voice finishUtterance / mockAsrTranscript behavior. */
export const MOCK_ASR_DEFAULT_TRANSCRIPT = "lab-transcript";

/** Historical lab TTS frame count (placeholder packets, not real Opus). */
export const MOCK_TTS_FRAME_COUNT = 8;

/**
 * Lab helper kept for tests and for callers that still pass listen/ASR hints
 * without a PCM buffer. Prefer MockAsrProvider.transcribe for new code.
 */
export function mockAsrTranscript(input: { listenText?: string; binaryNote?: string }): string {
  if (input.listenText !== undefined && input.listenText.length > 0) {
    return input.listenText;
  }
  if (input.binaryNote !== undefined && input.binaryNote.startsWith("ASR:")) {
    return input.binaryNote.slice(4);
  }
  return MOCK_ASR_DEFAULT_TRANSCRIPT;
}

function transcriptFromAudioBytes(audio: Buffer): string {
  if (audio.byteLength === 0) {
    return MOCK_ASR_DEFAULT_TRANSCRIPT;
  }
  const asText = audio.toString("utf8");
  if (asText.startsWith("ASR:")) {
    return mockAsrTranscript({ binaryNote: asText });
  }
  // Non-empty UTF-8 without the ASR: prefix is treated as typed listen text.
  if (!asText.includes("\0") && /^[\x09\x0a\x0d\x20-\x7e\u0080-\uffff]*$/.test(asText)) {
    return mockAsrTranscript({ listenText: asText });
  }
  return MOCK_ASR_DEFAULT_TRANSCRIPT;
}

/**
 * Default lab ASR: UTF-8 hint buffers (listen text or `ASR:…` notes) map to
 * the same transcript rules as before. Empty / binary PCM / WAV → `lab-transcript`.
 * WAV headers supply sampleRate/channels via resolveAsrAudio (whole-utterance path).
 * stream() is a usable stub: yields partial after each chunk, final on endOfUtterance
 * or when the async iterable ends.
 */
export class MockAsrProvider implements AsrProvider {
  async transcribe(audio: Buffer, options: AsrTranscribeOptions): Promise<string> {
    const resolved = resolveAsrAudio(audio, options);
    if (resolved.isWav) {
      // Real PCM from WAVE — lab has no model; return default (or UTF-8 if payload is a hint).
      return transcriptFromAudioBytes(resolved.pcm ?? Buffer.alloc(0));
    }
    return transcriptFromAudioBytes(resolved.audio);
  }

  async *stream(chunks: AsyncIterable<AsrStreamChunk>): AsyncIterable<AsrStreamResult> {
    let acc = Buffer.alloc(0);
    let lastPartial = "";
    let sampleRate = 16_000;
    let channels = 1;
    for await (const chunk of chunks) {
      if (chunk.sampleRate !== undefined) {
        sampleRate = chunk.sampleRate;
      }
      if (chunk.channels !== undefined) {
        channels = chunk.channels;
      }
      if (chunk.data.byteLength > 0) {
        acc = Buffer.concat([acc, chunk.data]);
      }
      const partial = await this.transcribe(acc, { sampleRate, channels, format: "pcm" });
      if (partial !== lastPartial) {
        lastPartial = partial;
        yield { partial };
      }
      if (chunk.endOfUtterance) {
        const finalText = await this.transcribe(acc, { sampleRate, channels, format: "pcm" });
        yield { final: finalText };
        return;
      }
    }
    const finalText = await this.transcribe(acc, { sampleRate, channels, format: "pcm" });
    yield { final: finalText };
  }
}

/**
 * Default lab TTS: yields `MOCK_TTS_FRAME_COUNT` placeholder packets
 * (`OB-OPUS-PLACEHOLDER`), preserving current npm run voice behavior.
 * Not real Opus; inject EdgeTTS/libopus (or similar) for playable packets.
 */
export class MockTtsProvider implements TtsProvider {
  readonly frameCount: number;

  constructor(frameCount: number = MOCK_TTS_FRAME_COUNT) {
    this.frameCount = frameCount;
  }

  async *synthesize(_text: string, _options: TtsSynthesizeOptions): AsyncIterable<Buffer> {
    const payload = Buffer.from(OPUS_PLACEHOLDER_MAGIC);
    for (let index = 0; index < this.frameCount; index += 1) {
      yield Buffer.from(payload);
    }
  }
}

export function createMockAsrProvider(): AsrProvider {
  return new MockAsrProvider();
}

export function createMockTtsProvider(frameCount?: number): TtsProvider {
  return new MockTtsProvider(frameCount);
}
