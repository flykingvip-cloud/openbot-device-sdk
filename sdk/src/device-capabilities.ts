/**
 * Plan A5 — device capability matrix and adapter-family slots.
 *
 * Declares what a device *family* can do (mic / storage / ble / usb / speaker)
 * and which adapter owns that family (metalio vs record-card vs generic).
 * This is SDK documentation + typed presets for later record-card work.
 *
 * Out of scope for A5:
 * - Full record-card implementation
 * - Any device-control v1 OpenAPI change (BLE/USB/mic/storage/speaker MUST NOT
 *   appear on `/api/device-platform/v1`)
 * - Contract / firmware pin changes
 * - api.tenclass.net
 */

/** Hardware / transport keys every device profile must declare. */
export const DEVICE_CAPABILITY_KEYS = ["mic", "storage", "ble", "usb", "speaker"] as const;

export type DeviceCapabilityKey = (typeof DEVICE_CAPABILITY_KEYS)[number];

/**
 * Presence of one capability.
 * `speaker` is commonly `optional` — devices may have mic without TTS playback.
 */
export type CapabilityPresence =
  | { readonly present: true; readonly notes?: string }
  | { readonly present: false; readonly notes?: string }
  | { readonly present: "optional"; readonly notes?: string };

/** Which adapter tree owns a device family. */
export const ADAPTER_FAMILY_SLOTS = ["metalio", "record-card", "generic"] as const;

export type AdapterFamilySlot = (typeof ADAPTER_FAMILY_SLOTS)[number];

/**
 * Opus semantic roles — never mix constants or bitrates across roles.
 * Reinforces docs/a2-metalio-voice.md "两套 Opus 语义".
 */
export const OPUS_SEMANTIC_ROLES = ["broadcast-frame", "recording-storage"] as const;

export type OpusSemanticRole = (typeof OPUS_SEMANTIC_ROLES)[number];

/**
 * Adapter implementation maturity for this slice.
 * `placeholder` = folder/README only; no runtime wire yet.
 */
export type AdapterSlotStatus = "implemented" | "placeholder" | "planned";

/**
 * How (if at all) this adapter may surface on frozen HTTP APIs.
 * Device-local caps (ble/usb/…) stay off device-control v1 OpenAPI.
 */
export type AdapterOpenApiSurface = "none" | "device-control-v1-forbidden";

export interface AdapterSlotDeclaration {
  readonly slot: AdapterFamilySlot;
  /** Path under `adapters/` when stubbed or implemented. */
  readonly adapterPath: string;
  /** Opus role this adapter owns, or null if none. */
  readonly opusRole: OpusSemanticRole | null;
  readonly status: AdapterSlotStatus;
  /**
   * BLE / USB / mic / storage / speaker declarations live in this matrix only.
   * They must not be added to `contracts/device-platform/device-control.openapi.yaml`.
   */
  readonly openApiSurface: AdapterOpenApiSurface;
  readonly summary: string;
}

export interface DeviceCapabilityMatrix {
  /** Stable profile id (not an instance `deviceId`). */
  readonly profileId: string;
  readonly displayName: string;
  readonly adapter: AdapterSlotDeclaration;
  readonly capabilities: Readonly<Record<DeviceCapabilityKey, CapabilityPresence>>;
  /**
   * TTS / speaker playback requirement relative to this profile.
   * Independent of whether `capabilities.speaker.present` is true — a board may
   * ship a speaker hardware path while product TTS remains optional to inject.
   */
  readonly ttsPlayback: "required" | "optional" | "unsupported";
}

/** Metalio Claw4 voice line — owns broadcast-frame Opus only. */
export const METALIO_ADAPTER_SLOT: AdapterSlotDeclaration = {
  slot: "metalio",
  adapterPath: "adapters/metalio",
  opusRole: "broadcast-frame",
  status: "implemented",
  openApiSurface: "none",
  summary:
    "Metalio WebSocket voice line: hello Opus uplink 16 kHz / downlink default 24 kHz / 60 ms bare packets. Not recording-storage Opus.",
};

/** Record-card / high-bitrate capture — placeholder for later slices. */
export const RECORD_CARD_ADAPTER_SLOT: AdapterSlotDeclaration = {
  slot: "record-card",
  adapterPath: "adapters/record-card",
  opusRole: "recording-storage",
  status: "placeholder",
  openApiSurface: "device-control-v1-forbidden",
  summary:
    "Recording-card family slot: high-bitrate storage Opus (often Ogg / ~256 kbps). Placeholder only in A5 — no wire, no OpenAPI.",
};

/** Catch-all for devices that are neither metalio nor record-card. */
export const GENERIC_ADAPTER_SLOT: AdapterSlotDeclaration = {
  slot: "generic",
  adapterPath: "adapters/generic",
  opusRole: null,
  status: "planned",
  openApiSurface: "device-control-v1-forbidden",
  summary: "Generic adapter family for non-metalio / non-record-card devices. Not implemented in A5.",
};

export const ADAPTER_FAMILY_REGISTRY: readonly AdapterSlotDeclaration[] = [
  METALIO_ADAPTER_SLOT,
  RECORD_CARD_ADAPTER_SLOT,
  GENERIC_ADAPTER_SLOT,
];

/** MetalioClaw4 baseline board profile (A0 SHA). Speaker/TTS optional to inject. */
export const METALIO_CAPABILITY_MATRIX: DeviceCapabilityMatrix = {
  profileId: "metalio-claw-4",
  displayName: "Metalio Claw4",
  adapter: METALIO_ADAPTER_SLOT,
  capabilities: {
    mic: { present: true, notes: "Uplink PCM → Opus broadcast frames via metalio hello" },
    storage: { present: true, notes: "On-device FAT/SPIFFS partitions; not recording-storage Opus" },
    ble: { present: "optional", notes: "Hardware may expose BLE; never surface on device-control v1 OpenAPI" },
    usb: { present: "optional", notes: "Host/debug USB if present; never surface on device-control v1 OpenAPI" },
    speaker: { present: "optional", notes: "Playback path for TTS downlink; product TTS remains injectable/optional" },
  },
  ttsPlayback: "optional",
};

/**
 * Record-card profile — types + docs only. Full capture/upload lands in later slices (A6+).
 * Speaker optional / often absent; focus is mic + storage Opus.
 */
export const RECORD_CARD_CAPABILITY_MATRIX: DeviceCapabilityMatrix = {
  profileId: "record-card-generic",
  displayName: "Record card (generic)",
  adapter: RECORD_CARD_ADAPTER_SLOT,
  capabilities: {
    mic: { present: true, notes: "Capture path for recording-storage Opus" },
    storage: { present: true, notes: "High-bitrate Opus / Ogg (or equivalent) on-device or staged file" },
    ble: { present: "optional", notes: "Some cards use BLE control; not in device-control v1" },
    usb: { present: "optional", notes: "Common mass-storage / CDC path; not in device-control v1" },
    speaker: { present: "optional", notes: "Often absent; recording-first devices do not require TTS" },
  },
  ttsPlayback: "unsupported",
};

export const DEVICE_CAPABILITY_MATRICES: readonly DeviceCapabilityMatrix[] = [
  METALIO_CAPABILITY_MATRIX,
  RECORD_CARD_CAPABILITY_MATRIX,
];

export function listAdapterFamilySlots(): readonly AdapterSlotDeclaration[] {
  return ADAPTER_FAMILY_REGISTRY;
}

export function getAdapterFamilySlot(slot: AdapterFamilySlot): AdapterSlotDeclaration {
  const found = ADAPTER_FAMILY_REGISTRY.find((item) => item.slot === slot);
  if (!found) {
    throw new Error(`unknown adapter family slot: ${slot}`);
  }
  return found;
}

export function listDeviceCapabilityMatrices(): readonly DeviceCapabilityMatrix[] {
  return DEVICE_CAPABILITY_MATRICES;
}

export function getDeviceCapabilityMatrix(profileId: string): DeviceCapabilityMatrix | undefined {
  return DEVICE_CAPABILITY_MATRICES.find((item) => item.profileId === profileId);
}

/** True when speaker capability is absent or explicitly optional (TTS not required). */
export function isSpeakerOptional(matrix: DeviceCapabilityMatrix): boolean {
  const speaker = matrix.capabilities.speaker;
  return speaker.present === false || speaker.present === "optional" || matrix.ttsPlayback !== "required";
}

/**
 * Guard for docs/tests: BLE must never be implied as a device-control v1 route surface.
 */
export function assertsNoDeviceControlOpenApiForLocalCaps(slot: AdapterSlotDeclaration): void {
  if (slot.openApiSurface === "device-control-v1-forbidden") {
    return;
  }
  if (slot.slot === "metalio" && slot.openApiSurface === "none") {
    return;
  }
  throw new Error(`adapter slot ${slot.slot} must not advertise local caps on device-control v1 OpenAPI`);
}
