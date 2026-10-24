/**
 * Env / config keys for optional ASR/TTS reference adapters (P1-1).
 *
 * Zero hardcoding of vendor hosts, model paths, or CLI commands:
 * every URL / model / voice / header comes from the caller or process env.
 * Defaults stay mock / placeholder — FunASR / EdgeTTS are never required at runtime.
 */

export const ASR_PROVIDER_ENV = "OPENBOT_ASR_PROVIDER";
export const ASR_HTTP_URL_ENV = "OPENBOT_ASR_HTTP_URL";
export const ASR_HTTP_MODEL_ENV = "OPENBOT_ASR_HTTP_MODEL";
export const ASR_HTTP_TEXT_FIELD_ENV = "OPENBOT_ASR_HTTP_TEXT_FIELD";
export const ASR_HTTP_HEADERS_JSON_ENV = "OPENBOT_ASR_HTTP_HEADERS_JSON";

export const TTS_PROVIDER_ENV = "OPENBOT_TTS_PROVIDER";
export const TTS_HTTP_URL_ENV = "OPENBOT_TTS_HTTP_URL";
export const TTS_HTTP_VOICE_ENV = "OPENBOT_TTS_HTTP_VOICE";
export const TTS_HTTP_HEADERS_JSON_ENV = "OPENBOT_TTS_HTTP_HEADERS_JSON";
export const TTS_SAMPLE_RATE_ENV = "OPENBOT_TTS_SAMPLE_RATE";

/** Optional root path Agent B / gateway uses to resolve this SDK checkout. */
export const DEVICE_SDK_ROOT_ENV = "OPENBOT_DEVICE_SDK_ROOT";

export type AsrProviderKind = "mock" | "reference-http";
export type TtsProviderKind =
  | "mock"
  | "reference-http"
  | "proportional-silence"
  | "opus-frame";

export interface ReferenceHttpAsrConfig {
  /** Absolute HTTP(S) URL of a FunASR-shaped (or compatible) transcribe endpoint. Required. */
  url: string;
  /** Optional model id / path passed as query `model` (caller-supplied; never defaulted to a vendor path). */
  model?: string;
  /** JSON response field that holds the transcript (default `text`). */
  textField?: string;
  /** Extra request headers (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface ReferenceHttpTtsConfig {
  /** Absolute HTTP(S) URL of an EdgeTTS-shaped (or compatible) synthesize endpoint. Required. */
  url: string;
  /** Optional voice id passed in the JSON body (caller-supplied). */
  voice?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

export interface VoiceReferenceEnvSelection {
  asrKind: AsrProviderKind;
  ttsKind: TtsProviderKind;
  asrHttp?: ReferenceHttpAsrConfig;
  ttsHttp?: ReferenceHttpTtsConfig;
  ttsSampleRate?: number;
}

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseHeadersJson(raw: string | undefined, envKey: string): Record<string, string> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${envKey} must be a JSON object of string headers: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${envKey} must be a JSON object of string headers`);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`${envKey}.${key} must be a string`);
    }
    headers[key] = value;
  }
  return headers;
}

function parseAsrKind(raw: string | undefined): AsrProviderKind {
  if (raw === undefined || raw === "mock") {
    return "mock";
  }
  if (raw === "reference-http" || raw === "funasr-http") {
    return "reference-http";
  }
  throw new Error(
    `${ASR_PROVIDER_ENV}=${raw} is unsupported; use mock | reference-http (alias: funasr-http)`,
  );
}

function parseTtsKind(raw: string | undefined): TtsProviderKind {
  if (raw === undefined || raw === "mock") {
    return "mock";
  }
  if (raw === "reference-http" || raw === "edgetts-http") {
    return "reference-http";
  }
  if (raw === "proportional-silence") {
    return "proportional-silence";
  }
  if (raw === "opus-frame") {
    return "opus-frame";
  }
  throw new Error(
    `${TTS_PROVIDER_ENV}=${raw} is unsupported; use mock | reference-http | proportional-silence | opus-frame (alias: edgetts-http)`,
  );
}

/**
 * Read provider selection + HTTP configs from env.
 * Never invents a vendor URL — reference-http requires *_HTTP_URL.
 */
export function readVoiceReferenceEnv(
  env: NodeJS.ProcessEnv = process.env,
): VoiceReferenceEnvSelection {
  const asrKind = parseAsrKind(readTrimmed(env, ASR_PROVIDER_ENV));
  const ttsKind = parseTtsKind(readTrimmed(env, TTS_PROVIDER_ENV));

  const selection: VoiceReferenceEnvSelection = { asrKind, ttsKind };

  if (asrKind === "reference-http") {
    const url = readTrimmed(env, ASR_HTTP_URL_ENV);
    if (url === undefined) {
      throw new Error(
        `${ASR_PROVIDER_ENV}=reference-http requires ${ASR_HTTP_URL_ENV} (no default vendor host)`,
      );
    }
    const model = readTrimmed(env, ASR_HTTP_MODEL_ENV);
    const textField = readTrimmed(env, ASR_HTTP_TEXT_FIELD_ENV);
    const headers = parseHeadersJson(readTrimmed(env, ASR_HTTP_HEADERS_JSON_ENV), ASR_HTTP_HEADERS_JSON_ENV);
    const asrHttp: ReferenceHttpAsrConfig = { url };
    if (model !== undefined) {
      asrHttp.model = model;
    }
    if (textField !== undefined) {
      asrHttp.textField = textField;
    }
    if (headers !== undefined) {
      asrHttp.headers = headers;
    }
    selection.asrHttp = asrHttp;
  }

  if (ttsKind === "reference-http") {
    const url = readTrimmed(env, TTS_HTTP_URL_ENV);
    if (url === undefined) {
      throw new Error(
        `${TTS_PROVIDER_ENV}=reference-http requires ${TTS_HTTP_URL_ENV} (no default vendor host)`,
      );
    }
    const voice = readTrimmed(env, TTS_HTTP_VOICE_ENV);
    const headers = parseHeadersJson(readTrimmed(env, TTS_HTTP_HEADERS_JSON_ENV), TTS_HTTP_HEADERS_JSON_ENV);
    const ttsHttp: ReferenceHttpTtsConfig = { url };
    if (voice !== undefined) {
      ttsHttp.voice = voice;
    }
    if (headers !== undefined) {
      ttsHttp.headers = headers;
    }
    selection.ttsHttp = ttsHttp;
  }

  const sampleRateRaw = readTrimmed(env, TTS_SAMPLE_RATE_ENV);
  if (sampleRateRaw !== undefined) {
    const sampleRate = Number(sampleRateRaw);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`${TTS_SAMPLE_RATE_ENV} must be a positive number`);
    }
    selection.ttsSampleRate = sampleRate;
  }

  return selection;
}
