export { ControlPlaneError, OtaDisabledError } from "./errors.ts";
export { ControlPlane } from "./control-plane.ts";
export {
  LAB_DEVICE_PLATFORM_ENDPOINTS,
  LAB_DEVICE_PROOF_HEADER,
  LAB_VOICE_WSS_ENV,
  LAB_VOICE_WSS_URL,
  assertLabLoopbackHost,
  buildLabDeviceConfig,
  handleLabOtaConfig,
  issueLabDeviceCredential,
  readLabDeviceCredential,
  refreshLabDeviceCredential,
  resolveLabVoiceWssUrl,
  startLabOtaConfigServer,
} from "./ota-config.ts";
export type { LabDeviceConfig, LabDeviceCredential, LabOtaConfigServer, LabPairingNext } from "./ota-config.ts";
export {
  DEVICE_CONTROL_API_PREFIX,
  DEVICE_CONTROL_ROUTES,
  DeviceControlError,
  deviceControlCapabilities,
  deviceControlHealth,
  startDeviceControlServer,
} from "./device-control.ts";
export type {
  DeviceControlCapabilities,
  DeviceControlHealth,
  DeviceControlServer,
  DeviceControlServerOptions,
  GrantReadInput,
  GrantVerifier,
  ServiceClientCredential,
} from "./device-control.ts";
export { LabPlayQueue, mockAsrTranscript, resolveAbortDecodePolicy, startLabVoiceServer } from "./lab-voice.ts";
export type { LabAbortReport, LabVoiceServer, LabVoiceServerOptions } from "./lab-voice.ts";
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
  parseWavPcm,
  resolveAsrAudio,
} from "../../adapters/voice/src/index.ts";
export type {
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
  AsrProviderKind,
  TtsProviderKind,
  ReferenceHttpAsrConfig,
  ReferenceHttpTtsConfig,
  VoiceProvidersBundle,
  VoiceReferenceEnvSelection,
} from "../../adapters/voice/src/index.ts";
export {
  InjectableAudioBridge,
  ProportionalSilenceTtsProvider,
  ReferenceHttpAsrProvider,
  ReferenceHttpTtsProvider,
  createAudioBridge,
  createAudioBridgeFromVoiceEnv,
  createProportionalSilenceTtsProvider,
  createReferenceHttpAsrProvider,
  createReferenceHttpTtsProvider,
  createVoiceProvidersFromEnv,
  readVoiceReferenceEnv,
  buildOpenBotServiceHeaders,
  ASR_PROVIDER_ENV,
  ASR_HTTP_URL_ENV,
  TTS_PROVIDER_ENV,
  TTS_HTTP_URL_ENV,
  DEVICE_SDK_ROOT_ENV,
} from "../../adapters/voice/src/index.ts";
export type {
  BindInput,
  CameraResultInput,
  CameraResultReceipt,
  ClaimTicket,
  ConnectionCredential,
  DeviceBindStatusName,
  DeviceControlRecord,
  PairChallengeTicket,
  PairOwnership,
  ConnectionCredentialAssessment,
  ConnectionCredentialRefusal,
  ControlPlaneOptions,
  LabOtaInput,
  LabOtaIntent,
  RebindInput,
  Revocation,
  VerifiedGrantBinding,
} from "./control-plane.ts";
export { CAMERA_RESULT_MAX_FRAME_BYTES, CONNECTION_CREDENTIAL_TTL_MS } from "./control-plane.ts";
export {
  FileStagingDb,
  MemoryStagingDb,
  STAGING_CONTROL_SECTION,
  STAGING_SESSION_SECTION,
  StagingConflictError,
  SqliteStagingDb,
  openStaging,
} from "./staging-db.ts";
export type { StagingDb } from "./staging-db.ts";
export {
  SIM_JOINT_PENDING,
  formatSimJointReport,
  runSimJointLoopback,
  simJointMissingEnv,
} from "./sim-joint.ts";
export type { SimJointCheck, SimJointOptions, SimJointReport } from "./sim-joint.ts";
export {
  DEVICE_ID_HEADER,
  VOICE_JOINT_CONTROL_URL_ENV,
  VOICE_JOINT_PENDING,
  VOICE_JOINT_TRANSCRIPT_ENV,
  formatVoiceJointReport,
  runVoiceJointLoopback,
  voiceJointMissingEnv,
} from "./voice-joint.ts";
export type { VoiceJointCheck, VoiceJointOptions, VoiceJointReport } from "./voice-joint.ts";
export {
  FORBIDDEN_PASSTHROUGH_HINTS,
  VOICE_HARNESS_ASSISTANT_DEFAULT,
  VOICE_HARNESS_PENDING,
  assertSpokenTtsProvider,
  buildKnownWavFixture,
  createMockAssistantDialogue,
  createVoiceLongitudinalHarness,
  formatVoiceHarnessReport,
  runVoiceHarnessSim,
} from "./voice-harness.ts";
export type {
  MockAssistantDialogue,
  VoiceHarnessCheck,
  VoiceHarnessLayer,
  VoiceHarnessLayerStatus,
  VoiceHarnessReport,
  VoiceHarnessSimOptions,
  VoiceLongitudinalHarness,
} from "./voice-harness.ts";
