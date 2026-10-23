export {
  CHANNEL_IDLE_TIMEOUT_SECONDS,
  C5_HOSTED_BIN_HOST,
  DECODE_QUEUE_BUDGET_MS,
  FIRMWARE_BOARD,
  FIRMWARE_REPO,
  FIRMWARE_SHA,
  FIRMWARE_TARGET,
  HELLO_TIMEOUT_MS,
  MAX_DECODE_PACKETS_IN_QUEUE,
  MAX_ENCODE_TASKS_IN_QUEUE,
  MAX_PLAYBACK_TASKS_IN_QUEUE,
  MAX_SEND_PACKETS_IN_QUEUE,
  OPUS_FRAME_DURATION_MS,
  PROTOCOL_VERSION_DEFAULT,
  SERVER_FRAME_DURATION_DEFAULT_MS,
  SERVER_SAMPLE_RATE_DEFAULT,
  UPLINK_CHANNELS,
  UPLINK_SAMPLE_RATE,
  XIAOZHI_OTA_HOST,
} from "./constants.ts";
export { ABORT_RESIDUAL_MS, MetalioAbortResidual } from "./abort-residual.ts";
export type { AbortDecodePolicy, EnqueueResult, MetalioAbortResidualOptions, MetalioDialogState } from "./abort-residual.ts";
export {
  OPUS_PLACEHOLDER_MAGIC,
  OpusBoundaryError,
  pcmBytesPerFrame,
  placeholderEncode,
  readPlaceholder,
} from "./opus-boundary.ts";
export type { OpusPlaceholderFrame, OpusSampleRate } from "./opus-boundary.ts";
export {
  LibopusFrameEncoder,
  createLibopusFrameEncoder,
  isOpusPlaceholderPayload,
  looksLikeRawOpusPacket,
} from "./opus-encoder.ts";
export type { CreateLibopusFrameEncoderOptions, OpusFrameEncoder } from "./opus-encoder.ts";
export {
  VOICE_WIRE,
  VoiceWireError,
  assertSessionId,
  buildAbortMessage,
  buildClientHello,
  buildListenMessage,
  buildMcpMessage,
  buildWebsocketHeaders,
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseServerHello,
} from "./voice-wire.ts";
export type { AbortReason, BinaryFrame, ClientHello, ListeningMode, ServerHello, WebsocketHeaderInput } from "./voice-wire.ts";

/** Re-export injectable voice providers for metalio consumers. */
export type {
  AsrAudioFormat,
  AsrFinalResult,
  AsrPartialResult,
  AsrProvider,
  AsrStreamChunk,
  AsrStreamResult,
  AsrTranscribeOptions,
  AsrUplinkCodec,
  ResolvedAsrAudio,
  TtsProvider,
  TtsSynthesizeOptions,
  WavPcmInfo,
  AudioBridge,
  AudioBridgeAbortHandle,
  AudioBridgeOptions,
  ProportionalSilenceTtsProviderOptions,
} from "../../voice/src/index.ts";
export {
  MOCK_ASR_DEFAULT_TRANSCRIPT,
  MOCK_TTS_FRAME_COUNT,
  MockAsrProvider,
  MockTtsProvider,
  OpusFrameTtsProvider,
  ProportionalSilenceTtsProvider,
  InjectableAudioBridge,
  WavParseError,
  buildWavPcm,
  createAudioBridge,
  createMockAsrProvider,
  createMockTtsProvider,
  createOpusFrameTtsProvider,
  createProportionalSilenceTtsProvider,
  isWavBuffer,
  mockAsrTranscript,
  parseWavPcm,
  resolveAsrAudio,
} from "../../voice/src/index.ts";
export type { OpusFrameTtsProviderOptions, OpusTtsPcmMode } from "../../voice/src/index.ts";
export {
  DEVICE_EDGE_DEVICE_ID_HEADER,
  DEVICE_EDGE_GRANT_HEADER,
  buildOpenBotServiceHeaders,
} from "../../voice/src/device-edge-auth.ts";
export type {
  DeviceEdgeAuthProxy,
  DeviceEdgeDeviceCredential,
  DeviceEdgeServiceCredential,
} from "../../voice/src/device-edge-auth.ts";
