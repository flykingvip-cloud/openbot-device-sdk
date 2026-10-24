/**
 * Optional FunASR-shaped HTTP ASR reference adapter (P1-1).
 *
 * POSTs whole-utterance audio to a caller-configured URL and reads a JSON
 * transcript field. Compatible with typical local FunASR / SenseVoice HTTP
 * wrappers — but the SDK never hardcodes a host, model path, or vendor name
 * into the request beyond what config supplies.
 *
 * Not loaded unless constructed or selected via the reference factory.
 */

import { resolveAsrAudio } from "../asr-audio.ts";
import type {
  AsrProvider,
  AsrStreamChunk,
  AsrStreamResult,
  AsrTranscribeOptions,
} from "../asr-provider.ts";
import type { ReferenceHttpAsrConfig } from "./config.ts";

export type FetchLike = typeof fetch;

export interface ReferenceHttpAsrProviderOptions extends ReferenceHttpAsrConfig {
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

function readTextField(body: unknown, field: string): string {
  if (typeof body === "string") {
    return body;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ReferenceHttpAsrProvider: response JSON must be an object or string");
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    throw new Error(`ReferenceHttpAsrProvider: response missing string field "${field}"`);
  }
  return value;
}

/**
 * Whole-utterance HTTP ASR. `stream()` is optional and not implemented here
 * (Opus→PCM / streaming FunASR remains a later slice).
 */
export class ReferenceHttpAsrProvider implements AsrProvider {
  readonly url: string;
  readonly model: string | undefined;
  readonly textField: string;
  readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(options: ReferenceHttpAsrProviderOptions) {
    if (!options.url || options.url.trim().length === 0) {
      throw new Error("ReferenceHttpAsrProvider requires options.url from config/env");
    }
    this.url = options.url.trim();
    this.model = options.model?.trim() || undefined;
    this.textField = (options.textField?.trim() || "text");
    this.headers = { ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(audio: Buffer, options: AsrTranscribeOptions): Promise<string> {
    const resolved = resolveAsrAudio(audio, options);
    const target = new URL(this.url);
    if (this.model !== undefined) {
      target.searchParams.set("model", this.model);
    }
    target.searchParams.set("sampleRate", String(resolved.options.sampleRate));
    target.searchParams.set("channels", String(resolved.options.channels));
    if (resolved.options.format !== undefined) {
      target.searchParams.set("format", resolved.options.format);
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": resolved.isWav ? "audio/wav" : "application/octet-stream",
      ...this.headers,
    };

    const response = await this.fetchImpl(target, {
      method: "POST",
      headers,
      body: new Uint8Array(resolved.audio),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `ReferenceHttpAsrProvider HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      return readTextField(await response.json(), this.textField);
    }
    const asText = (await response.text()).trim();
    if (asText.length === 0) {
      throw new Error("ReferenceHttpAsrProvider: empty transcript body");
    }
    try {
      return readTextField(JSON.parse(asText), this.textField);
    } catch {
      return asText;
    }
  }

  /**
   * Streaming FunASR is out of scope for this reference slice.
   * Callers needing stream() should inject a real streaming provider.
   */
  async *stream(_chunks: AsyncIterable<AsrStreamChunk>): AsyncIterable<AsrStreamResult> {
    throw new Error(
      "ReferenceHttpAsrProvider.stream is not implemented; use MockAsrProvider or a streaming FunASR inject",
    );
  }
}

export function createReferenceHttpAsrProvider(
  options: ReferenceHttpAsrProviderOptions,
): AsrProvider {
  return new ReferenceHttpAsrProvider(options);
}
