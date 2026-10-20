export {
  CONTRACT_PIN,
  FROZEN_TOP_LEVEL_FIELDS,
  FrozenFieldError,
  LIVE_STUB_ENV,
  OBSOLETE_CONTRACT_REPO,
  OBSOLETE_CONTRACT_SHA_PREFIX,
  OPENBOT_CONTRACT_REPO,
  OPENBOT_CONTRACT_SHA,
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
  DEVICE_TOOLS,
  DISABLED_DEVICE_COMMANDS,
  DeviceToolError,
  describeSystemRebootCommand,
  invokeDeviceTool,
} from "./device-tools.ts";
export type { DeviceToolInput, DeviceToolName, DeviceToolResult } from "./device-tools.ts";

export { ControlPlane, OtaDisabledError } from "../../services/src/index.ts";
export type { ClaimTicket, LabOtaIntent } from "../../services/src/index.ts";
