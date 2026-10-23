export type {
  AsrAudioFormat,
  AsrFinalResult,
  AsrPartialResult,
  AsrProvider,
  AsrStreamChunk,
  AsrStreamResult,
  AsrTranscribeOptions,
  AsrUplinkCodec,
} from "./asr-provider.ts";
export type { TtsProvider, TtsSynthesizeOptions } from "./tts-provider.ts";
export {
  MOCK_ASR_DEFAULT_TRANSCRIPT,
  MOCK_TTS_FRAME_COUNT,
  MockAsrProvider,
  MockTtsProvider,
  createMockAsrProvider,
  createMockTtsProvider,
  mockAsrTranscript,
} from "./mock.ts";
export {
  OpusFrameTtsProvider,
  createOpusFrameTtsProvider,
} from "./opus-tts-provider.ts";
export type { OpusFrameTtsProviderOptions, OpusTtsPcmMode } from "./opus-tts-provider.ts";
export { resolveAsrAudio } from "./asr-audio.ts";
export type { ResolvedAsrAudio } from "./asr-audio.ts";
export { WavParseError, buildWavPcm, isWavBuffer, parseWavPcm } from "./wav.ts";
export type { WavPcmInfo } from "./wav.ts";

export {
  InjectableAudioBridge,
  ProportionalSilenceTtsProvider,
  createAudioBridge,
  createProportionalSilenceTtsProvider,
} from "./audio-bridge.ts";
export type {
  AudioBridge,
  AudioBridgeAbortHandle,
  AudioBridgeOptions,
  ProportionalSilenceTtsProviderOptions,
  SynthesizeOpusOptions,
  TranscribeWavOptions,
} from "./audio-bridge.ts";

export {
  DEVICE_EDGE_DEVICE_ID_HEADER,
  DEVICE_EDGE_GRANT_HEADER,
  buildOpenBotServiceHeaders,
} from "./device-edge-auth.ts";
export type {
  DeviceEdgeAuthProxy,
  DeviceEdgeDeviceCredential,
  DeviceEdgeServiceCredential,
} from "./device-edge-auth.ts";
