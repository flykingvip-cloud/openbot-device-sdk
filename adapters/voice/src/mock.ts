import { OPUS_PLACEHOLDER_MAGIC } from "../../metalio/src/opus-boundary.ts";
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

/**
 * Default lab ASR: UTF-8 hint buffers (listen text or `ASR:…` notes) map to
 * the same transcript rules as before. Empty audio → `lab-transcript`.
 * Streaming is reserved and rejects until a real provider is injected.
 */
export class MockAsrProvider implements AsrProvider {
  async transcribe(audio: Buffer, _options: AsrTranscribeOptions): Promise<string> {
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

  async *stream(_chunks: AsyncIterable<AsrStreamChunk>): AsyncIterable<AsrStreamResult> {
    throw new Error("MockAsrProvider.stream is a reserved stub; inject a real AsrProvider for streaming ASR");
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
