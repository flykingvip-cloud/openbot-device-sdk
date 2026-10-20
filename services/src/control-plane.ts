import { randomInt, randomUUID } from "node:crypto";

import {
  FrozenFieldError,
  assertFrozenBinding,
  assertJsonValue,
  assertNoFrozenAliases,
  cloneAssistant,
  isPlainObject,
  type AssistantFields,
  type FrozenBinding,
} from "../../contracts/src/index.ts";
import { C5_HOSTED_BIN_HOST, XIAOZHI_OTA_HOST } from "../../adapters/metalio/src/constants.ts";
import { invalidateDigitalHumanCache } from "../../integrations/openbot-b1/src/index.ts";
import { ControlPlaneError, OtaDisabledError } from "./errors.ts";
import { STAGING_CONTROL_SECTION, type StagingDb } from "./staging-db.ts";

const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Short-lived connection credential. Refresh is a local stub, not a network call. */
export const CONNECTION_CREDENTIAL_TTL_MS = 15 * 60 * 1000;

/** Descriptor size cap. The plane stores the count, never pixels and never a URL. */
export const CAMERA_RESULT_MAX_FRAME_BYTES = 8_000_000;

const STATE_VERSION = 1;

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

export interface ConnectionCredential {
  deviceId: string;
  token: string;
  expiresAtMs: number;
  authorizationRef: string;
  bindingVersion: number;
}

export interface Revocation {
  deviceId: string;
  revokedAtMs: number;
}

export interface CameraResultInput {
  deviceId: string;
  token: string;
  capturedAtMs: number;
  frameBytes: number;
}

export interface CameraResultReceipt {
  accepted: true;
  deviceId: string;
  capturedAtMs: number;
  frameBytes: number;
  storedImage: false;
}

export interface ControlPlaneOptions {
  now?: () => number;
  code?: () => string;
  authorizationRef?: () => string;
  token?: () => string;
  credentialTtlMs?: number;
  /** When set, claim/bind/OTA/credential/revoke state survives a new `ControlPlane` on the same db. */
  store?: StagingDb;
}

export interface BindInput {
  deviceId: string;
  digitalHumanId: string;
  assistant: AssistantFields;
}

export interface RebindInput {
  digitalHumanId?: string;
  /** New grant profile. Field name stays `assistant`; the stored value is replaced. */
  assistant?: AssistantFields;
  deviceId?: string;
  authorizationRef?: string;
  bindingVersion?: number;
}

export interface SessionLifecycleListener {
  invalidateDevice(deviceId: string, reason: "revoked" | "rebound"): number;
}

export interface LabOtaInput {
  deviceId: string;
  version: string;
  force?: number;
  firmwareUrl?: string | null;
  scope?: string;
  rollout?: string;
}

interface ControlSection {
  version: typeof STATE_VERSION;
  claims: ClaimRecord[];
  bindings: FrozenBinding[];
  ota: LabOtaIntent[];
  credentials: ConnectionCredential[];
  revoked: Revocation[];
}

const PRODUCTION_HOSTS = [XIAOZHI_OTA_HOST, C5_HOSTED_BIN_HOST];

function defaultCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * Claim, bind, and lab OTA record.
 * Without `store`, state stays in memory for unit tests.
 * With a file or sqlite `StagingDb`, the next process reloads it.
 * `flash` and `massFlash` always throw. No firmware URL is stored.
 * `refreshConnectionCredential` is a local stub and does not call a network.
 */
export class ControlPlane {
  private readonly claims = new Map<string, ClaimRecord>();
  private readonly bindings = new Map<string, FrozenBinding>();
  private readonly ota = new Map<string, LabOtaIntent>();
  private readonly credentials = new Map<string, ConnectionCredential>();
  private readonly revoked = new Map<string, Revocation>();
  private readonly now: () => number;
  private readonly code: () => string;
  private readonly authorizationRef: () => string;
  private readonly token: () => string;
  private readonly credentialTtlMs: number;
  private readonly store: StagingDb | undefined;
  private readonly sessionLifecycles: Array<WeakRef<SessionLifecycleListener>> = [];

  constructor(options: ControlPlaneOptions = {}) {
    this.now = options.now ?? Date.now;
    this.code = options.code ?? defaultCode;
    this.authorizationRef = options.authorizationRef ?? (() => `aref_${randomUUID()}`);
    this.token = options.token ?? (() => `ctok_${randomUUID()}`);
    if (
      options.credentialTtlMs !== undefined &&
      (!Number.isFinite(options.credentialTtlMs) || options.credentialTtlMs <= 0)
    ) {
      throw new ControlPlaneError("credential_ttl", "credential TTL must be positive");
    }
    this.credentialTtlMs = options.credentialTtlMs ?? CONNECTION_CREDENTIAL_TTL_MS;
    this.store = options.store;
    if (this.store) {
      this.hydrate();
    }
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
    this.persist();
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
    this.persist();
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
    this.persist();
    return structuredClone(binding);
  }

  /** Session books register here so revoke and rebind close the old run immediately. */
  attachSessionLifecycle(listener: SessionLifecycleListener): void {
    this.sessionLifecycles.push(new WeakRef(listener));
  }

  /**
   * Rotates `authorizationRef` and increments `bindingVersion`.
   * `deviceId` stays put. `authorizationRef` and `bindingVersion` cannot be chosen by the caller.
   * A new `assistant` value is stored under the same field name.
   * Changing `digitalHumanId` without a new assistant profile is rejected.
   * Short-lived tokens are dropped, the reply cache is cleared, and open sessions are closed.
   */
  rebind(deviceId: string, input: RebindInput = {}): FrozenBinding {
    assertNoFrozenAliases(input);
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
    const assistant = this.assistantForRebind(current, digitalHumanId, input.assistant);
    const next: FrozenBinding = {
      authorizationRef: this.authorizationRef(),
      bindingVersion: current.bindingVersion + 1,
      digitalHumanId,
      deviceId: current.deviceId,
      assistant,
    };
    this.dropCredentials(deviceId);
    this.revoked.delete(deviceId);
    this.bindings.set(deviceId, next);
    invalidateDigitalHumanCache(this);
    this.notifySessions(deviceId, "rebound");
    this.persist();
    return structuredClone(next);
  }

  claimStatus(deviceId: string): "missing" | "pending" | "claimed" {
    const claim = this.claims.get(deviceId);
    if (!claim) {
      return "missing";
    }
    return claim.status;
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
    const intent = buildLabOtaIntent(input);
    this.ota.set(input.deviceId, intent);
    this.persist();
    return { ...intent };
  }

  getLabOta(deviceId: string): LabOtaIntent | undefined {
    const intent = this.ota.get(deviceId);
    return intent === undefined ? undefined : { ...intent };
  }

  /**
   * Issues one short-lived connection token for a bound device.
   * Any previous token for that device is cleared. Revoked devices are refused.
   */
  issueConnectionCredential(deviceId: string): ConnectionCredential {
    if (this.revoked.has(deviceId)) {
      throw new ControlPlaneError("credential_revoked", "revoked devices cannot issue connection credentials");
    }
    const binding = this.requireBinding(deviceId);
    this.dropCredentials(deviceId);
    const credential = this.mintCredential(binding);
    this.credentials.set(credential.token, credential);
    this.persist();
    return { ...credential };
  }

  /**
   * Local reconnect stub. Rotates the short-lived token when the presented token
   * is still the active one and the device is not revoked.
   * An expired token may be refreshed. A revoked device may not.
   * This method does not call `fetch` or any OTA host.
   */
  refreshConnectionCredential(deviceId: string, token: string): ConnectionCredential {
    if (this.revoked.has(deviceId)) {
      throw new ControlPlaneError("credential_revoked", "revoked devices cannot refresh connection credentials");
    }
    const current = this.credentials.get(token);
    if (!current || current.deviceId !== deviceId) {
      throw new ControlPlaneError("credential_missing", "connection credential is not active");
    }
    const binding = this.requireBinding(deviceId);
    if (current.authorizationRef !== binding.authorizationRef || current.bindingVersion !== binding.bindingVersion) {
      this.credentials.delete(token);
      this.persist();
      throw new ControlPlaneError("credential_stale", "connection credential does not match the frozen binding");
    }
    this.credentials.delete(token);
    const next = this.mintCredential(binding);
    this.credentials.set(next.token, next);
    this.persist();
    return { ...next };
  }

  getConnectionCredential(token: string): ConnectionCredential | undefined {
    const found = this.credentials.get(token);
    return found === undefined ? undefined : { ...found };
  }

  activeConnectionCredential(deviceId: string): ConnectionCredential | undefined {
    for (const credential of this.credentials.values()) {
      if (credential.deviceId === deviceId) {
        return { ...credential };
      }
    }
    return undefined;
  }

  activeCredentialCount(deviceId: string): number {
    let count = 0;
    for (const credential of this.credentials.values()) {
      if (credential.deviceId === deviceId) {
        count += 1;
      }
    }
    return count;
  }

  isRevoked(deviceId: string): boolean {
    return this.revoked.has(deviceId);
  }

  /**
   * Clears short-lived tokens and marks the device revoked.
   * The frozen binding, including `assistant.*`, stays in place.
   */
  revoke(deviceId: string): { deviceId: string; clearedTokens: number } {
    if (!this.bindings.has(deviceId)) {
      throw new ControlPlaneError("bind_missing", "device is not bound");
    }
    const clearedTokens = this.dropCredentials(deviceId);
    this.revoked.set(deviceId, { deviceId, revokedAtMs: this.now() });
    this.notifySessions(deviceId, "revoked");
    this.persist();
    return { deviceId, clearedTokens };
  }

  /**
   * Accepts a camera descriptor only while the token is active.
   * Revoke is checked before the token, so a result captured earlier and delivered
   * after revoke is still rejected. No image bytes and no URL are stored.
   */
  submitCameraResult(input: CameraResultInput): CameraResultReceipt {
    if (input.deviceId.length === 0) {
      throw new ControlPlaneError("camera_device", "deviceId is required");
    }
    if (this.revoked.has(input.deviceId)) {
      throw new ControlPlaneError("camera_revoked", "camera result rejected after revoke");
    }
    if (
      !Number.isInteger(input.frameBytes) ||
      input.frameBytes < 1 ||
      input.frameBytes > CAMERA_RESULT_MAX_FRAME_BYTES
    ) {
      throw new ControlPlaneError("camera_frame", "frameBytes must be a positive descriptor size, not an image payload");
    }
    if (!Number.isFinite(input.capturedAtMs)) {
      throw new ControlPlaneError("camera_time", "capturedAtMs must be finite");
    }
    const credential = this.credentials.get(input.token);
    if (!credential || credential.deviceId !== input.deviceId) {
      throw new ControlPlaneError("credential_missing", "connection credential is not active");
    }
    if (this.now() >= credential.expiresAtMs) {
      throw new ControlPlaneError("credential_expired", "connection credential expired");
    }
    const binding = this.bindings.get(input.deviceId);
    if (
      !binding ||
      credential.authorizationRef !== binding.authorizationRef ||
      credential.bindingVersion !== binding.bindingVersion
    ) {
      throw new ControlPlaneError("credential_stale", "connection credential does not match the frozen binding");
    }
    return {
      accepted: true,
      deviceId: input.deviceId,
      capturedAtMs: input.capturedAtMs,
      frameBytes: input.frameBytes,
      storedImage: false,
    };
  }

  flash(): never {
    throw new OtaDisabledError("ota_disabled", "flash is disabled; this control plane does not write a firmware image");
  }

  massFlash(): never {
    throw new OtaDisabledError("mass_flash", "mass flash is disabled");
  }

  private assistantForRebind(
    current: FrozenBinding,
    digitalHumanId: string,
    assistant: AssistantFields | undefined,
  ): AssistantFields {
    if (assistant !== undefined) {
      assertJsonValue(assistant, "assistant");
      if (!isPlainObject(assistant)) {
        throw new FrozenFieldError("assistant");
      }
      return cloneAssistant(assistant);
    }
    if (digitalHumanId !== current.digitalHumanId) {
      throw new ControlPlaneError("rebind_profile", "rebind to a new digitalHumanId requires the new assistant profile");
    }
    return cloneAssistant(current.assistant);
  }

  private notifySessions(deviceId: string, reason: "revoked" | "rebound"): void {
    let index = 0;
    while (index < this.sessionLifecycles.length) {
      const listener = this.sessionLifecycles[index]?.deref();
      if (!listener) {
        this.sessionLifecycles.splice(index, 1);
        continue;
      }
      listener.invalidateDevice(deviceId, reason);
      index += 1;
    }
  }

  private requireBinding(deviceId: string): FrozenBinding {
    const binding = this.bindings.get(deviceId);
    if (!binding) {
      throw new ControlPlaneError("credential_unbound", "connection credentials require a bound device");
    }
    return binding;
  }

  private mintCredential(binding: FrozenBinding): ConnectionCredential {
    const token = this.token();
    if (token.length === 0 || token.length > 200 || /\s/.test(token)) {
      throw new ControlPlaneError("credential_token", "connection token must be a non-empty single token");
    }
    if (this.credentials.has(token)) {
      throw new ControlPlaneError("credential_token", "connection token collided");
    }
    return {
      deviceId: binding.deviceId,
      token,
      expiresAtMs: this.now() + this.credentialTtlMs,
      authorizationRef: binding.authorizationRef,
      bindingVersion: binding.bindingVersion,
    };
  }

  private dropCredentials(deviceId: string): number {
    let cleared = 0;
    for (const [token, credential] of this.credentials) {
      if (credential.deviceId === deviceId) {
        this.credentials.delete(token);
        cleared += 1;
      }
    }
    return cleared;
  }

  private hydrate(): void {
    const raw = this.store?.get(STAGING_CONTROL_SECTION);
    if (raw === undefined) {
      return;
    }
    const section = parseControlSection(raw);
    this.claims.clear();
    this.bindings.clear();
    this.ota.clear();
    this.credentials.clear();
    this.revoked.clear();
    for (const claim of section.claims) {
      this.claims.set(claim.deviceId, claim);
    }
    for (const binding of section.bindings) {
      this.bindings.set(binding.deviceId, binding);
    }
    for (const intent of section.ota) {
      this.ota.set(intent.deviceId, intent);
    }
    for (const credential of section.credentials) {
      this.credentials.set(credential.token, credential);
    }
    for (const revocation of section.revoked) {
      this.revoked.set(revocation.deviceId, revocation);
    }
  }

  private persist(): void {
    if (!this.store) {
      return;
    }
    const section: ControlSection = {
      version: STATE_VERSION,
      claims: [...this.claims.values()].map((claim) => ({ ...claim })),
      bindings: [...this.bindings.values()].map((binding) => structuredClone(binding)),
      ota: [...this.ota.values()].map((intent) => ({ ...intent })),
      credentials: [...this.credentials.values()].map((credential) => ({ ...credential })),
      revoked: [...this.revoked.values()].map((revocation) => ({ ...revocation })),
    };
    this.store.set(STAGING_CONTROL_SECTION, section);
  }
}

function buildLabOtaIntent(input: LabOtaInput): LabOtaIntent {
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
  return {
    deviceId: input.deviceId,
    version: input.version,
    force: 0,
    firmwareUrl: null,
    executable: false,
    scope: "single-device",
    rollout: "lab-record-only",
  };
}

function productionHost(url: string): string | undefined {
  try {
    const host = new URL(url).host;
    return PRODUCTION_HOSTS.find((blocked) => host === blocked);
  } catch {
    return undefined;
  }
}

function parseControlSection(raw: unknown): ControlSection {
  if (!isPlainObject(raw) || raw.version !== STATE_VERSION) {
    throw new ControlPlaneError("state_corrupt", "control-plane state version mismatch");
  }
  const claims = parseClaims(raw.claims);
  const bindings = parseBindings(raw.bindings);
  const ota = parseOta(raw.ota);
  const credentials = parseCredentials(raw.credentials);
  const revoked = parseRevocations(raw.revoked);
  return { version: STATE_VERSION, claims, bindings, ota, credentials, revoked };
}

function parseClaims(value: unknown): ClaimRecord[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("state_corrupt", "claims must be an array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isPlainObject(item)) {
      throw new ControlPlaneError("state_corrupt", "claim must be an object");
    }
    const { deviceId, code, expiresAtMs, status } = item;
    if (typeof deviceId !== "string" || deviceId.length === 0 || seen.has(deviceId)) {
      throw new ControlPlaneError("state_corrupt", "claim deviceId is invalid");
    }
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      throw new ControlPlaneError("state_corrupt", "claim code must be 6 digits");
    }
    if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) {
      throw new ControlPlaneError("state_corrupt", "claim expiry is invalid");
    }
    if (status !== "pending" && status !== "claimed") {
      throw new ControlPlaneError("state_corrupt", "claim status is invalid");
    }
    seen.add(deviceId);
    return { deviceId, code, expiresAtMs, status };
  });
}

function parseBindings(value: unknown): FrozenBinding[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("state_corrupt", "bindings must be an array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const binding = assertFrozenBinding(item);
    if (seen.has(binding.deviceId)) {
      throw new ControlPlaneError("state_corrupt", "duplicate binding deviceId");
    }
    seen.add(binding.deviceId);
    return binding;
  });
}

function parseOta(value: unknown): LabOtaIntent[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("state_corrupt", "ota records must be an array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isPlainObject(item)) {
      throw new ControlPlaneError("state_corrupt", "ota record must be an object");
    }
    const { deviceId, version, force, firmwareUrl, executable, scope, rollout } = item;
    if (typeof deviceId !== "string" || deviceId.length === 0 || seen.has(deviceId)) {
      throw new ControlPlaneError("state_corrupt", "ota deviceId is invalid");
    }
    if (
      typeof version !== "string" ||
      version.length === 0 ||
      version.includes("://") ||
      force !== 0 ||
      firmwareUrl !== null ||
      executable !== false ||
      scope !== "single-device" ||
      rollout !== "lab-record-only"
    ) {
      throw new ControlPlaneError("state_corrupt", "lab OTA record must stay non-executable");
    }
    seen.add(deviceId);
    return {
      deviceId,
      version,
      force: 0,
      firmwareUrl: null,
      executable: false,
      scope: "single-device",
      rollout: "lab-record-only",
    };
  });
}

function parseCredentials(value: unknown): ConnectionCredential[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("state_corrupt", "credentials must be an array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isPlainObject(item)) {
      throw new ControlPlaneError("state_corrupt", "credential must be an object");
    }
    const { deviceId, token, expiresAtMs, authorizationRef, bindingVersion } = item;
    if (typeof deviceId !== "string" || deviceId.length === 0) {
      throw new ControlPlaneError("state_corrupt", "credential deviceId is invalid");
    }
    if (typeof token !== "string" || token.length === 0 || seen.has(token)) {
      throw new ControlPlaneError("state_corrupt", "credential token is invalid");
    }
    if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) {
      throw new ControlPlaneError("state_corrupt", "credential expiry is invalid");
    }
    if (typeof authorizationRef !== "string" || authorizationRef.length === 0) {
      throw new ControlPlaneError("state_corrupt", "credential authorizationRef is invalid");
    }
    if (typeof bindingVersion !== "number" || !Number.isInteger(bindingVersion) || bindingVersion < 1) {
      throw new ControlPlaneError("state_corrupt", "credential bindingVersion is invalid");
    }
    seen.add(token);
    return { deviceId, token, expiresAtMs, authorizationRef, bindingVersion };
  });
}

function parseRevocations(value: unknown): Revocation[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("state_corrupt", "revocations must be an array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isPlainObject(item)) {
      throw new ControlPlaneError("state_corrupt", "revocation must be an object");
    }
    const { deviceId, revokedAtMs } = item;
    if (typeof deviceId !== "string" || deviceId.length === 0 || seen.has(deviceId)) {
      throw new ControlPlaneError("state_corrupt", "revocation deviceId is invalid");
    }
    if (typeof revokedAtMs !== "number" || !Number.isFinite(revokedAtMs)) {
      throw new ControlPlaneError("state_corrupt", "revocation time is invalid");
    }
    seen.add(deviceId);
    return { deviceId, revokedAtMs };
  });
}
