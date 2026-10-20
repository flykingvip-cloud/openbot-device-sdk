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
export { LabPlayQueue, mockAsrTranscript, startLabVoiceServer } from "./lab-voice.ts";
export type { LabAbortReport, LabVoiceServer } from "./lab-voice.ts";
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
  SqliteStagingDb,
  openStaging,
} from "./staging-db.ts";
export type { StagingDb } from "./staging-db.ts";
