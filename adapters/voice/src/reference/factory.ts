/**
 * Factory: select AsrProvider / TtsProvider / AudioBridge from env or explicit config.
 * Default remains mock — FunASR / EdgeTTS reference HTTP is opt-in via URL + kind.
 */

import {
  createAudioBridge,
  createProportionalSilenceTtsProvider,
  type AudioBridge,
  type AudioBridgeOptions,
} from "../audio-bridge.ts";
import {
  createMockAsrProvider,
  createMockTtsProvider,
} from "../mock.ts";
import { createOpusFrameTtsProvider } from "../opus-tts-provider.ts";
import type { AsrProvider } from "../asr-provider.ts";
import type { TtsProvider } from "../tts-provider.ts";
import {
  readVoiceReferenceEnv,
  type AsrProviderKind,
  type ReferenceHttpAsrConfig,
  type ReferenceHttpTtsConfig,
  type TtsProviderKind,
  type VoiceReferenceEnvSelection,
} from "./config.ts";
import { createReferenceHttpAsrProvider, type FetchLike } from "./http-asr.ts";
import { createReferenceHttpTtsProvider } from "./http-tts.ts";

export interface CreateVoiceProvidersOptions {
  /** Override env selection; when omitted, reads process.env (or `env`). */
  selection?: VoiceReferenceEnvSelection;
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch for reference-http providers (tests). */
  fetchImpl?: FetchLike;
  /**
   * When true, selecting ttsKind=opus-frame throws: product spoken TTS must not
   * use OpusFrameTtsProvider (it ignores text). Lab/format callers may pass false.
   * Default true for createAudioBridgeFromVoiceEnv.
   */
  forbidOpusFrameForSpoken?: boolean;
}

export interface VoiceProvidersBundle {
  asr: AsrProvider;
  tts: TtsProvider;
  asrKind: AsrProviderKind;
  ttsKind: TtsProviderKind;
  ttsSampleRate?: number;
}

export function createAsrProviderFromKind(
  kind: AsrProviderKind,
  http: ReferenceHttpAsrConfig | undefined,
  fetchImpl?: FetchLike,
): AsrProvider {
  if (kind === "mock") {
    return createMockAsrProvider();
  }
  if (http === undefined) {
    throw new Error("reference-http ASR requires http config (OPENBOT_ASR_HTTP_URL)");
  }
  const options = fetchImpl !== undefined ? { ...http, fetchImpl } : { ...http };
  return createReferenceHttpAsrProvider(options);
}

export function createTtsProviderFromKind(
  kind: TtsProviderKind,
  http: ReferenceHttpTtsConfig | undefined,
  options: { fetchImpl?: FetchLike; forbidOpusFrameForSpoken?: boolean } = {},
): TtsProvider {
  if (kind === "mock") {
    return createMockTtsProvider();
  }
  if (kind === "proportional-silence") {
    return createProportionalSilenceTtsProvider();
  }
  if (kind === "opus-frame") {
    if (options.forbidOpusFrameForSpoken !== false) {
      throw new Error(
        "ttsKind=opus-frame is lab/format only (OpusFrameTtsProvider ignores text). " +
          "For product spoken TTS use reference-http (EdgeTTS-shaped) or inject a real TtsProvider. " +
          "Pass forbidOpusFrameForSpoken:false only for lab format probes.",
      );
    }
    return createOpusFrameTtsProvider();
  }
  if (http === undefined) {
    throw new Error("reference-http TTS requires http config (OPENBOT_TTS_HTTP_URL)");
  }
  const ttsOptions =
    options.fetchImpl !== undefined ? { ...http, fetchImpl: options.fetchImpl } : { ...http };
  return createReferenceHttpTtsProvider(ttsOptions);
}

/**
 * Build ASR+TTS from env/config. Default kinds are mock (no FunASR/EdgeTTS runtime).
 */
export function createVoiceProvidersFromEnv(
  options: CreateVoiceProvidersOptions = {},
): VoiceProvidersBundle {
  const selection = options.selection ?? readVoiceReferenceEnv(options.env ?? process.env);
  const asr = createAsrProviderFromKind(selection.asrKind, selection.asrHttp, options.fetchImpl);
  const tts = createTtsProviderFromKind(selection.ttsKind, selection.ttsHttp, {
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.forbidOpusFrameForSpoken !== undefined
      ? { forbidOpusFrameForSpoken: options.forbidOpusFrameForSpoken }
      : {}),
  });
  const bundle: VoiceProvidersBundle = {
    asr,
    tts,
    asrKind: selection.asrKind,
    ttsKind: selection.ttsKind,
  };
  if (selection.ttsSampleRate !== undefined) {
    bundle.ttsSampleRate = selection.ttsSampleRate;
  }
  return bundle;
}

/**
 * createAudioBridge wired from env/config for OpenBot gateway / Agent B.
 *
 * Typical Agent B inject:
 * - OPENBOT_DEVICE_SDK_ROOT=/path/to/openbot-device-sdk
 * - import { createAudioBridgeFromVoiceEnv } from `<SDK_ROOT>/adapters/voice/src/reference/index.ts`
 *   (or re-export from adapters/voice)
 * - Default mock until OPENBOT_ASR_PROVIDER / OPENBOT_TTS_PROVIDER + URLs are set
 *
 * Do NOT select opus-frame for product播报 (forbidden by default here).
 */
export function createAudioBridgeFromVoiceEnv(
  options: CreateVoiceProvidersOptions = {},
): AudioBridge {
  const forbid = options.forbidOpusFrameForSpoken ?? true;
  const bundle = createVoiceProvidersFromEnv({ ...options, forbidOpusFrameForSpoken: forbid });
  const bridgeOptions: AudioBridgeOptions = {
    asr: bundle.asr,
    tts: bundle.tts,
  };
  if (bundle.ttsSampleRate !== undefined) {
    bridgeOptions.ttsSampleRate = bundle.ttsSampleRate;
  }
  return createAudioBridge(bridgeOptions);
}
