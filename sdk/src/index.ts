export {
  CONTRACT_PIN,
  FROZEN_TOP_LEVEL_FIELDS,
  FrozenFieldError,
  LIVE_STUB_ENV,
  OBSOLETE_CONTRACT_REPO,
  OBSOLETE_CONTRACT_SHA_PREFIX,
  OPENBOT_CONTRACT_PR,
  OPENBOT_CONTRACT_REPO,
  OPENBOT_CONTRACT_SHA,
  PREVIOUS_CONTRACT_SHA,
  OLDER_CONTRACT_SHA,
  INVALIDATED_CONTRACT_SHAS,
  assertFrozenBinding,
  assistantEqual,
  loadStandInDocument,
} from "../../contracts/src/index.ts";
export type { AssistantFields, FrozenBinding } from "../../contracts/src/index.ts";

export {
  ABORT_RESIDUAL_MS,
  FIRMWARE_REPO,
  FIRMWARE_SHA,
  MAX_DECODE_PACKETS_IN_QUEUE,
  MetalioAbortResidual,
  OPUS_FRAME_DURATION_MS,
  OPUS_PLACEHOLDER_MAGIC,
  buildAbortMessage,
  buildClientHello,
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseServerHello,
  placeholderEncode,
} from "../../adapters/metalio/src/index.ts";

export {
  CAMERA,
  CHAT_EMOTION_NAMES,
  DISPLAY,
  EMOTION_CATEGORIES,
  EMOTE_CATEGORY_MAP,
  chatEmotionPath,
  digitalHumanEmotionPath,
  emotionCategory,
  mediaCapabilities,
} from "./media.ts";
export type { EmotionCategory, MediaCapabilities } from "./media.ts";

export {
  ADAPTER_FAMILY_REGISTRY,
  ADAPTER_FAMILY_SLOTS,
  DEVICE_CAPABILITY_KEYS,
  DEVICE_CAPABILITY_MATRICES,
  GENERIC_ADAPTER_SLOT,
  METALIO_ADAPTER_SLOT,
  METALIO_CAPABILITY_MATRIX,
  OPUS_SEMANTIC_ROLES,
  RECORD_CARD_ADAPTER_SLOT,
  RECORD_CARD_CAPABILITY_MATRIX,
  assertsNoDeviceControlOpenApiForLocalCaps,
  getAdapterFamilySlot,
  getDeviceCapabilityMatrix,
  isSpeakerOptional,
  listAdapterFamilySlots,
  listDeviceCapabilityMatrices,
} from "./device-capabilities.ts";
export type {
  AdapterFamilySlot,
  AdapterOpenApiSurface,
  AdapterSlotDeclaration,
  AdapterSlotStatus,
  CapabilityPresence,
  DeviceCapabilityKey,
  DeviceCapabilityMatrix,
  OpusSemanticRole,
} from "./device-capabilities.ts";

export {
  DEVICE_TOOLS,
  DISABLED_DEVICE_COMMANDS,
  DeviceToolError,
  describeSystemRebootCommand,
  invokeDeviceTool,
} from "./device-tools.ts";
export type { DeviceToolInput, DeviceToolName, DeviceToolResult } from "./device-tools.ts";

export {
  ControlPlane,
  FileStagingDb,
  MemoryStagingDb,
  OtaDisabledError,
  SqliteStagingDb,
  openStaging,
} from "../../services/src/index.ts";
export type {
  CameraResultReceipt,
  ClaimTicket,
  ConnectionCredential,
  LabOtaIntent,
  StagingDb,
} from "../../services/src/index.ts";

export {
  MOCK_ASR_DEFAULT_TRANSCRIPT,
  MOCK_TTS_FRAME_COUNT,
  MockAsrProvider,
  MockTtsProvider,
  WavParseError,
  buildWavPcm,
  createMockAsrProvider,
  createMockTtsProvider,
  isWavBuffer,
  mockAsrTranscript,
  parseWavPcm,
  resolveAsrAudio,
} from "../../adapters/voice/src/index.ts";
export type {
  AsrAudioFormat,
  AsrFinalResult,
  AsrPartialResult,
  AsrProvider,
  AsrStreamChunk,
  AsrStreamResult,
  AsrTranscribeOptions,
  ResolvedAsrAudio,
  TtsProvider,
  TtsSynthesizeOptions,
  WavPcmInfo,
} from "../../adapters/voice/src/index.ts";

