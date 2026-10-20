import { randomInt, randomUUID } from "node:crypto";

import {
  FrozenFieldError,
  assertJsonValue,
  assertNoFrozenAliases,
  assistantEqual,
  cloneAssistant,
  isPlainObject,
  type AssistantFields,
  type FrozenBinding,
} from "../../contracts/src/index.ts";
import { C5_HOSTED_BIN_HOST, XIAOZHI_OTA_HOST } from "../../adapters/metalio/src/constants.ts";
import { ControlPlaneError, OtaDisabledError } from "./errors.ts";

const CLAIM_TTL_MS = 10 * 60 * 1000;

export interface ClaimTicket {
  deviceId: string;
  code: string;
  expiresAtMs: number;
}

interface ClaimRecord extends ClaimTicket {
  status: "pending" | "claimed";
}

export interface LabOtaIntent {
  deviceId: string;
  version: string;
  force: 0;
  firmwareUrl: null;
  executable: false;
  scope: "single-device";
  rollout: "lab-record-only";
}

export interface ControlPlaneOptions {
  now?: () => number;
  code?: () => string;
  authorizationRef?: () => string;
}

export interface BindInput {
  deviceId: string;
  digitalHumanId: string;
  assistant: AssistantFields;
}

export interface RebindInput {
  digitalHumanId?: string;
  assistant?: unknown;
  deviceId?: string;
  authorizationRef?: string;
  bindingVersion?: number;
}

export interface LabOtaInput {
  deviceId: string;
  version: string;
  force?: number;
  firmwareUrl?: string | null;
  scope?: string;
  rollout?: string;
}

const PRODUCTION_HOSTS = [XIAOZHI_OTA_HOST, C5_HOSTED_BIN_HOST];

function defaultCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * In-memory claim, bind, and OTA record.
 * `flash` and `massFlash` always throw. No firmware URL is stored, so this
 * plane cannot drive `Ota::Upgrade` or a fleet rollout.
 */
export class ControlPlane {
  private readonly claims = new Map<string, ClaimRecord>();
  private readonly bindings = new Map<string, FrozenBinding>();
  private readonly ota = new Map<string, LabOtaIntent>();
  private readonly now: () => number;
  private readonly code: () => string;
  private readonly authorizationRef: () => string;

  constructor(options: ControlPlaneOptions = {}) {
    this.now = options.now ?? Date.now;
    this.code = options.code ?? defaultCode;
    this.authorizationRef = options.authorizationRef ?? (() => `aref_${randomUUID()}`);
  }

  issueClaim(deviceId: string): ClaimTicket {
    if (deviceId.length === 0) {
      throw new ControlPlaneError("claim_device", "deviceId is required");
    }
    const ticket: ClaimRecord = {
      deviceId,
      code: this.code(),
      expiresAtMs: this.now() + CLAIM_TTL_MS,
      status: "pending",
    };
    if (!/^\d{6}$/.test(ticket.code)) {
      throw new ControlPlaneError("claim_code", "claim code must be 6 digits");
    }
    this.claims.set(deviceId, ticket);
    return { deviceId, code: ticket.code, expiresAtMs: ticket.expiresAtMs };
  }

  redeemClaim(deviceId: string, code: string): { deviceId: string } {
    const claim = this.claims.get(deviceId);
    if (!claim || claim.status !== "pending") {
      throw new ControlPlaneError("claim_missing", "no pending claim for deviceId");
    }
    if (this.now() >= claim.expiresAtMs) {
      throw new ControlPlaneError("claim_expired", "claim code expired");
    }
    if (claim.code !== code) {
      throw new ControlPlaneError("claim_code", "claim code does not match");
    }
    claim.status = "claimed";
    return { deviceId };
  }

  bind(input: BindInput): FrozenBinding {
    assertNoFrozenAliases(input);
    const claim = this.claims.get(input.deviceId);
    if (!claim || claim.status !== "claimed") {
      throw new ControlPlaneError("bind_unclaimed", "device must be claimed before bind");
    }
    if (this.bindings.has(input.deviceId)) {
      throw new ControlPlaneError("bind_exists", "device is already bound; use rebind");
    }
    if (input.digitalHumanId.length === 0) {
      throw new FrozenFieldError("digitalHumanId");
    }
    assertJsonValue(input.assistant, "assistant");
    if (!isPlainObject(input.assistant)) {
      throw new FrozenFieldError("assistant");
    }
    const binding: FrozenBinding = {
      authorizationRef: this.authorizationRef(),
      bindingVersion: 1,
      digitalHumanId: input.digitalHumanId,
      deviceId: input.deviceId,
      assistant: cloneAssistant(input.assistant),
    };
    this.bindings.set(input.deviceId, binding);
    return structuredClone(binding);
  }

  /**
   * Rotates `authorizationRef` and increments `bindingVersion`.
   * `deviceId` stays put. `assistant.*` is copied from the current binding.
   * Passing `assistant`, `deviceId`, `authorizationRef`, or `bindingVersion` is rejected.
   */
  rebind(deviceId: string, input: RebindInput = {}): FrozenBinding {
    assertNoFrozenAliases(input);
    if ("assistant" in input) {
      throw new FrozenFieldError("assistant");
    }
    if (input.deviceId !== undefined) {
      throw new FrozenFieldError("deviceId");
    }
    if (input.authorizationRef !== undefined) {
      throw new FrozenFieldError("authorizationRef");
    }
    if (input.bindingVersion !== undefined) {
      throw new FrozenFieldError("bindingVersion");
    }
    const current = this.bindings.get(deviceId);
    if (!current) {
      throw new ControlPlaneError("bind_missing", "device is not bound");
    }
    const digitalHumanId = input.digitalHumanId ?? current.digitalHumanId;
    if (digitalHumanId.length === 0) {
      throw new FrozenFieldError("digitalHumanId");
    }
    const next: FrozenBinding = {
      authorizationRef: this.authorizationRef(),
      bindingVersion: current.bindingVersion + 1,
      digitalHumanId,
      deviceId: current.deviceId,
      assistant: cloneAssistant(current.assistant),
    };
    if (!assistantEqual(next.assistant, current.assistant)) {
      throw new FrozenFieldError("assistant");
    }
    this.bindings.set(deviceId, next);
    return structuredClone(next);
  }

  getBinding(deviceId: string): FrozenBinding | undefined {
    const binding = this.bindings.get(deviceId);
    return binding === undefined ? undefined : structuredClone(binding);
  }

  findByDigitalHuman(digitalHumanId: string): FrozenBinding[] {
    return [...this.bindings.values()]
      .filter((binding) => binding.digitalHumanId === digitalHumanId)
      .map((binding) => structuredClone(binding));
  }

  proposeLabOta(input: LabOtaInput): LabOtaIntent {
    if (!this.bindings.has(input.deviceId)) {
      throw new ControlPlaneError("ota_unbound", "OTA records require a bound device");
    }
    if (input.scope !== undefined && input.scope !== "single-device") {
      throw new OtaDisabledError("mass_flash", "only a single already-bound device can hold a lab OTA record");
    }
    if (input.rollout === "production" || input.rollout === "mass" || input.rollout === "fleet") {
      throw new OtaDisabledError("production_ota", "production, mass, and fleet OTA rollouts are disabled");
    }
    if (input.force !== undefined && input.force !== 0) {
      throw new OtaDisabledError("force_flag", "firmware.force must stay 0; force=1 is disabled");
    }
    if (input.firmwareUrl !== undefined && input.firmwareUrl !== null) {
      const host = productionHost(input.firmwareUrl);
      if (host) {
        throw new OtaDisabledError("production_ota", `firmware host ${host} is not a device-platform endpoint`);
      }
      throw new OtaDisabledError("firmware_url", "lab OTA records do not store a firmware URL");
    }
    if (input.version.length === 0 || input.version.includes("://")) {
      throw new OtaDisabledError("firmware_url", "OTA version must be a version string, not a URL");
    }
    const intent: LabOtaIntent = {
      deviceId: input.deviceId,
      version: input.version,
      force: 0,
      firmwareUrl: null,
      executable: false,
      scope: "single-device",
      rollout: "lab-record-only",
    };
    this.ota.set(input.deviceId, intent);
    return { ...intent };
  }

  getLabOta(deviceId: string): LabOtaIntent | undefined {
    const intent = this.ota.get(deviceId);
    return intent === undefined ? undefined : { ...intent };
  }

  flash(): never {
    throw new OtaDisabledError("ota_disabled", "flash is disabled; this control plane does not write a firmware image");
  }

  massFlash(): never {
    throw new OtaDisabledError("mass_flash", "mass flash is disabled");
  }
}

function productionHost(url: string): string | undefined {
  try {
    const host = new URL(url).host;
    return PRODUCTION_HOSTS.find((blocked) => host === blocked);
  } catch {
    return undefined;
  }
}
