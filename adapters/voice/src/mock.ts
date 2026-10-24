import { OPUS_PLACEHOLDER_MAGIC } from "../../metalio/src/opus-boundary.ts";
import { resolveAsrAudio } from "./asr-audio.ts";
import type { AsrProvider, AsrStreamChunk, AsrStreamResult, AsrTranscribeOptions } from "./asr-provider.ts";
import {
  createOpusUplinkDecoder,
  resolveAsrStreamCodec,
  type OpusUplinkDecoder,
} from "./opus-uplink.ts";
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
 *
 * P1-2: when codec/format is `"opus"`, each chunk is one uplink packet; packet
 * boundaries are preserved and decoded to PCM via libopus before transcript rules.
 * Undecodable stub bytes still must not be labeled or fed as PCM samples.
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
    let accPcm = Buffer.alloc(0);
    let lastPartial = "";
    let sampleRate = 16_000;
    let channels = 1;
    let opusDecoder: OpusUplinkDecoder | undefined;
    let sawOpus = false;
    let undecodableOpusPackets = 0;

    const ensureOpusDecoder = (): OpusUplinkDecoder => {
      if (opusDecoder === undefined) {
        opusDecoder = createOpusUplinkDecoder({
          sampleRate: sampleRate === 24_000 ? 24_000 : 16_000,
        });
      }
      return opusDecoder;
    };

    try {
      for await (const chunk of chunks) {
        const codec = resolveAsrStreamCodec(chunk);
        if (chunk.sampleRate !== undefined) {
          sampleRate = chunk.sampleRate;
        }
        if (chunk.channels !== undefined) {
          channels = chunk.channels;
        }

        if (codec === "opus") {
          sawOpus = true;
          // Never treat Opus packet bytes as PCM. Decode or count undecodable stubs.
          if (chunk.data.byteLength > 0) {
            try {
              const pcm = ensureOpusDecoder().decodePacket(chunk.data);
              if (pcm.byteLength > 0) {
                accPcm = Buffer.concat([accPcm, pcm]);
              }
            } catch {
              undecodableOpusPackets += 1;
            }
          }
        } else if (chunk.data.byteLength > 0) {
          accPcm = Buffer.concat([accPcm, chunk.data]);
        }

        const partial =
          sawOpus && accPcm.byteLength === 0 && undecodableOpusPackets > 0
            ? MOCK_ASR_DEFAULT_TRANSCRIPT
            : await this.transcribe(accPcm, { sampleRate, channels, format: "pcm" });
        if (partial !== lastPartial) {
          lastPartial = partial;
          yield { partial };
        }
        if (chunk.endOfUtterance) {
          const finalText =
            sawOpus && accPcm.byteLength === 0 && undecodableOpusPackets > 0
              ? MOCK_ASR_DEFAULT_TRANSCRIPT
              : await this.transcribe(accPcm, { sampleRate, channels, format: "pcm" });
          yield { final: finalText };
          return;
        }
      }
      const finalText =
        sawOpus && accPcm.byteLength === 0 && undecodableOpusPackets > 0
          ? MOCK_ASR_DEFAULT_TRANSCRIPT
          : await this.transcribe(accPcm, { sampleRate, channels, format: "pcm" });
      yield { final: finalText };
    } finally {
      opusDecoder?.destroy();
    }
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
