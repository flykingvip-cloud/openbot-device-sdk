/**
 * Optional ASR/TTS reference adapters (P1-1).
 *
 * Pluggable FunASR- / EdgeTTS-shaped HTTP implementations + env factory.
 * Default SDK path remains MockAsrProvider / MockTtsProvider — importing this
 * submodule does not pull model weights or require a live vendor runtime.
 */

export {
  ASR_HTTP_HEADERS_JSON_ENV,
  ASR_HTTP_MODEL_ENV,
  ASR_HTTP_TEXT_FIELD_ENV,
  ASR_HTTP_URL_ENV,
  ASR_PROVIDER_ENV,
  DEVICE_SDK_ROOT_ENV,
  TTS_HTTP_HEADERS_JSON_ENV,
  TTS_HTTP_URL_ENV,
  TTS_HTTP_VOICE_ENV,
  TTS_PROVIDER_ENV,
  TTS_SAMPLE_RATE_ENV,
  readVoiceReferenceEnv,
} from "./config.ts";
export type {
  AsrProviderKind,
  ReferenceHttpAsrConfig,
  ReferenceHttpTtsConfig,
  TtsProviderKind,
  VoiceReferenceEnvSelection,
} from "./config.ts";

export {
  ReferenceHttpAsrProvider,
  createReferenceHttpAsrProvider,
} from "./http-asr.ts";
export type { FetchLike, ReferenceHttpAsrProviderOptions } from "./http-asr.ts";

export {
  ReferenceHttpTtsProvider,
  createReferenceHttpTtsProvider,
} from "./http-tts.ts";
export type { ReferenceHttpTtsProviderOptions } from "./http-tts.ts";

export {
  createAsrProviderFromKind,
  createAudioBridgeFromVoiceEnv,
  createTtsProviderFromKind,
  createVoiceProvidersFromEnv,
} from "./factory.ts";
export type {
  CreateVoiceProvidersOptions,
  VoiceProvidersBundle,
} from "./factory.ts";
