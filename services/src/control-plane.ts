import { randomInt, randomUUID } from "node:crypto";

import {
  FrozenFieldError,
  assertFrozenBinding,
  assertJsonValue,
  assertNoFrozenAliases,
  assistantEqual,
  cloneAssistant,
  isPlainObject,
  type AssistantFields,
  type FrozenBinding,
} from "../../contracts/src/index.ts";
import { C5_HOSTED_BIN_HOST, XIAOZHI_OTA_HOST } from "../../adapters/metalio/src/constants.ts";
import { invalidateDigitalHumanCache } from "../../integrations/openbot-b1/src/index.ts";
import { ControlPlaneError, OtaDisabledError } from "./errors.ts";
import { STAGING_CONTROL_SECTION, StagingConflictError, type StagingDb } from "./staging-db.ts";

const CLAIM_TTL_MS = 10 * 60 * 1000;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SERVICE_PRINCIPAL_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const PAIR_CHALLENGE_PATTERN = /^pch_[A-Za-z0-9_-]{8,80}$/;
const PAIRING_FIELD_NAMES = new Set(["pairChallenge", "pairingChallenge", "pairingCode", "ownershipProof", "pairNonce"]);

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

export type ConnectionCredentialRefusal =
  | "credential_missing"
  | "credential_revoked"
  | "credential_expired"
  | "credential_stale";

export type ConnectionCredentialAssessment =
  | { ok: true; code: "ok"; credential: ConnectionCredential }
  | { ok: false; code: ConnectionCredentialRefusal };

function credentialRefusalMessage(code: ConnectionCredentialRefusal): string {
  if (code === "credential_expired") {
    return "connection credential expired";
  }
  if (code === "credential_stale") {
    return "connection credential does not match the frozen binding";
  }
  if (code === "credential_revoked") {
    return "revoked devices cannot use connection credentials";
  }
  return "connection credential is not active";
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
  /** When set, durable store is authoritative across ControlPlane instances on the same db. */
  store?: StagingDb;
  /** Opaque pair-challenge id. The default is `pch_` plus a UUID. */
  pairChallengeId?: () => string;
}

/** One-time device-platform challenge. `pairingCode` is shown once, at creation. */
export interface PairChallengeTicket {
  pairChallenge: string;
  deviceId: string;
  pairingCode: string;
  expiresAtMs: number;
  status: "pending";
}

export interface PairOwnership {
  pairChallenge: string;
  deviceId: string;
  servicePrincipal: string;
  status: "redeemed";
  ownership: "verified";
}

export type DeviceBindStatusName = "unbound" | "bound" | "revoked";

/**
 * Device visible to one service principal.
 * `authorizationRef` is copied from a verified OpenBot grant when `source` is `openbot-grant`.
 * `pairingCode` is never included.
 */
export interface DeviceControlRecord {
  deviceId: string;
  servicePrincipal: string;
  ownership: "pending" | "verified";
  bindStatus: DeviceBindStatusName;
  revoked: boolean;
  pairChallenge?: string;
  authorizationRef?: string;
  bindingVersion?: number;
  digitalHumanId?: string;
  assistant?: AssistantFields;
  source?: "openbot-grant";
}

/** Grant fields already checked against OpenBot. This object is not a client body. */
export interface VerifiedGrantBinding {
  authorizationRef: string;
  bindingVersion: number;
  digitalHumanId: string;
  deviceId: string;
  assistant: AssistantFields;
  status?: string;
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

interface PairChallengeRecord {
  pairChallenge: string;
  deviceId: string;
  pairingCode: string;
  expiresAtMs: number;
  status: "pending" | "redeemed";
  servicePrincipal: string;
  redeemedAtMs?: number;
}

interface DevicePrincipalRecord {
  deviceId: string;
  servicePrincipal: string;
}

interface ControlSection {
  version: typeof STATE_VERSION;
  claims: ClaimRecord[];
  bindings: FrozenBinding[];
  ota: LabOtaIntent[];
  credentials: ConnectionCredential[];
  revoked: Revocation[];
  pairChallenges: PairChallengeRecord[];
  devicePrincipals: DevicePrincipalRecord[];
  grantBound: string[];
}

const PRODUCTION_HOSTS = [XIAOZHI_OTA_HOST, C5_HOSTED_BIN_HOST];

function defaultCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * Claim, bind, and lab OTA record.
 * Without `store`, state stays in memory for unit tests.
 * With a file or sqlite `StagingDb`, the durable section is authoritative: security-sensitive
 * reads (credential assess / revoke checks) reload it, and mutating writes use optimistic
 * concurrency so a second ControlPlane on the same db cannot silently clobber the first.
 * Sharing one in-process ControlPlane instance remains a valid lab deploy option; it is not
 * a substitute for that cross-process correctness.
 * `flash` and `massFlash` always throw. No firmware URL is stored.
 * `refreshConnectionCredential` is a local stub and does not call a network.
 * `applyVerifiedGrant` stores an OpenBot grant as-is and does not mint `authorizationRef`.
 */
export class ControlPlane {
  private readonly claims = new Map<string, ClaimRecord>();
  private readonly bindings = new Map<string, FrozenBinding>();
  private readonly ota = new Map<string, LabOtaIntent>();
  private readonly credentials = new Map<string, ConnectionCredential>();
  private readonly revoked = new Map<string, Revocation>();
  private readonly pairChallenges = new Map<string, PairChallengeRecord>();
  private readonly principals = new Map<string, string>();
  private readonly grantBound = new Set<string>();
  private readonly now: () => number;
  private readonly code: () => string;
  private readonly authorizationRef: () => string;
  private readonly token: () => string;
  private readonly pairChallengeId: () => string;
  private readonly credentialTtlMs: number;
  private readonly store: StagingDb | undefined;
  /** Last observed durable control-section revision when `store` is set. */
  private storeRevision = 0;
  private readonly sessionLifecycles: Array<WeakRef<SessionLifecycleListener>> = [];

  constructor(options: ControlPlaneOptions = {}) {
    this.now = options.now ?? Date.now;
    this.code = options.code ?? defaultCode;
    this.authorizationRef = options.authorizationRef ?? (() => `aref_${randomUUID()}`);
    this.token = options.token ?? (() => `ctok_${randomUUID()}`);
    this.pairChallengeId = options.pairChallengeId ?? (() => `pch_${randomUUID()}`);
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
    this.refreshFromAuthoritativeStore();
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
    this.refreshFromAuthoritativeStore();
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
    this.refreshFromAuthoritativeStore();
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
    this.refreshFromAuthoritativeStore();
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
    this.refreshFromAuthoritativeStore();
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
   * In-process callers already hold the control plane. HTTP issue must use
   * `issueConnectionCredentialWithProof` so a device id alone cannot mint a token.
   */
  issueConnectionCredential(deviceId: string): ConnectionCredential {
    this.refreshFromAuthoritativeStore();
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
   * HTTP issue path. The redeemed claim code is the lab device proof.
   * A device id without that code does not mint a token.
   */
  issueConnectionCredentialWithProof(deviceId: string, claimCode: string): ConnectionCredential {
    this.refreshFromAuthoritativeStore();
    if (this.revoked.has(deviceId)) {
      throw new ControlPlaneError("credential_revoked", "revoked devices cannot issue connection credentials");
    }
    const claim = this.claims.get(deviceId);
    if (!claim || claim.status !== "claimed" || claim.code !== claimCode) {
      throw new ControlPlaneError("device_proof", "device identity was not verified");
    }
    return this.issueConnectionCredential(deviceId);
  }

  /**
   * Full check for using a connection credential: revoke, device, binding, and expiry.
   * When a durable store is configured, this reloads authoritative state first so a
   * peer instance's revoke or rebind is observed.
   * Refresh does not call this. An expired token may still be refreshed.
   */
  assessConnectionCredential(deviceId: string, token: string | undefined): ConnectionCredentialAssessment {
    this.refreshFromAuthoritativeStore();
    if (this.revoked.has(deviceId)) {
      return { ok: false, code: "credential_revoked" };
    }
    if (token === undefined || token.length === 0) {
      return { ok: false, code: "credential_missing" };
    }
    const credential = this.credentials.get(token);
    if (!credential || credential.deviceId !== deviceId) {
      return { ok: false, code: "credential_missing" };
    }
    const binding = this.bindings.get(deviceId);
    if (
      !binding ||
      credential.authorizationRef !== binding.authorizationRef ||
      credential.bindingVersion !== binding.bindingVersion
    ) {
      return { ok: false, code: "credential_stale" };
    }
    if (this.now() >= credential.expiresAtMs) {
      return { ok: false, code: "credential_expired" };
    }
    return { ok: true, code: "ok", credential: { ...credential } };
  }

  /**
   * Local reconnect stub. Rotates the short-lived token when the presented token
   * is still the active one and the device is not revoked.
   * An expired token may be refreshed. A revoked device may not.
   * This method does not call `fetch` or any OTA host.
   */
  refreshConnectionCredential(deviceId: string, token: string): ConnectionCredential {
    this.refreshFromAuthoritativeStore();
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
    this.refreshFromAuthoritativeStore();
    const found = this.credentials.get(token);
    return found === undefined ? undefined : { ...found };
  }

  activeConnectionCredential(deviceId: string): ConnectionCredential | undefined {
    this.refreshFromAuthoritativeStore();
    for (const credential of this.credentials.values()) {
      if (credential.deviceId === deviceId) {
        return { ...credential };
      }
    }
    return undefined;
  }

  activeCredentialCount(deviceId: string): number {
    this.refreshFromAuthoritativeStore();
    let count = 0;
    for (const credential of this.credentials.values()) {
      if (credential.deviceId === deviceId) {
        count += 1;
      }
    }
    return count;
  }

  isRevoked(deviceId: string): boolean {
    this.refreshFromAuthoritativeStore();
    return this.revoked.has(deviceId);
  }

  /**
   * Clears short-lived tokens and marks the device revoked.
   * The frozen binding, including `assistant.*`, stays in place.
   */
  revoke(deviceId: string): { deviceId: string; clearedTokens: number } {
    this.refreshFromAuthoritativeStore();
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
    this.refreshFromAuthoritativeStore();
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
    const decision = this.assessConnectionCredential(input.deviceId, input.token);
    if (!decision.ok) {
      throw new ControlPlaneError(decision.code, credentialRefusalMessage(decision.code));
    }
    return {
      accepted: true,
      deviceId: input.deviceId,
      capturedAtMs: input.capturedAtMs,
      frameBytes: input.frameBytes,
      storedImage: false,
    };
  }

  /**
   * Starts a one-time pairing challenge for a service principal.
   * The 6-digit `pairingCode` is the claim code. It is not an OpenBot field.
   */
  createPairChallenge(deviceId: string, servicePrincipal: string): PairChallengeTicket {
    this.refreshFromAuthoritativeStore();
    assertDeviceId(deviceId);
    assertServicePrincipal(servicePrincipal);
    const owner = this.principals.get(deviceId);
    if (owner !== undefined && owner !== servicePrincipal) {
      throw new ControlPlaneError("pair_owned", "device is owned by another service principal");
    }
    const pairChallenge = this.pairChallengeId();
    if (!PAIR_CHALLENGE_PATTERN.test(pairChallenge) || this.pairChallenges.has(pairChallenge)) {
      throw new ControlPlaneError("pair_challenge", "pair challenge id is invalid");
    }
    const ticket = this.issueClaim(deviceId);
    for (const [id, challenge] of this.pairChallenges) {
      if (challenge.deviceId === deviceId && challenge.status === "pending") {
        this.pairChallenges.delete(id);
      }
    }
    const record: PairChallengeRecord = {
      pairChallenge,
      deviceId,
      pairingCode: ticket.code,
      expiresAtMs: ticket.expiresAtMs,
      status: "pending",
      servicePrincipal,
    };
    this.pairChallenges.set(pairChallenge, record);
    this.persist();
    return {
      pairChallenge,
      deviceId,
      pairingCode: ticket.code,
      expiresAtMs: ticket.expiresAtMs,
      status: "pending",
    };
  }

  /** Verifies ownership. A repeat by the same principal with the same code stays redeemed. */
  redeemPairChallenge(input: {
    pairChallenge: string;
    deviceId: string;
    pairingCode: string;
    servicePrincipal: string;
  }): PairOwnership {
    this.refreshFromAuthoritativeStore();
    assertDeviceId(input.deviceId);
    assertServicePrincipal(input.servicePrincipal);
    const challenge = this.pairChallenges.get(input.pairChallenge);
    if (!challenge) {
      throw new ControlPlaneError("pair_missing", "pair challenge was not found");
    }
    if (challenge.servicePrincipal !== input.servicePrincipal) {
      throw new ControlPlaneError("pair_owned", "pair challenge belongs to another service principal");
    }
    if (challenge.deviceId !== input.deviceId) {
      throw new ControlPlaneError("pair_device", "pair challenge does not match deviceId");
    }
    if (challenge.pairingCode !== input.pairingCode) {
      throw new ControlPlaneError("pair_code", "pairing code does not match");
    }
    if (challenge.status === "redeemed") {
      return ownershipOf(challenge);
    }
    if (this.now() >= challenge.expiresAtMs) {
      throw new ControlPlaneError("pair_expired", "pair challenge expired");
    }
    this.redeemClaim(input.deviceId, input.pairingCode);
    challenge.status = "redeemed";
    challenge.redeemedAtMs = this.now();
    this.principals.set(input.deviceId, input.servicePrincipal);
    this.persist();
    return ownershipOf(challenge);
  }

  listDevicesForPrincipal(servicePrincipal: string): DeviceControlRecord[] {
    assertServicePrincipal(servicePrincipal);
    const seen = new Set<string>();
    const devices: DeviceControlRecord[] = [];
    for (const [deviceId, owner] of this.principals) {
      if (owner === servicePrincipal) {
        seen.add(deviceId);
        devices.push(this.deviceRecord(deviceId));
      }
    }
    for (const challenge of this.pairChallenges.values()) {
      if (
        challenge.servicePrincipal !== servicePrincipal ||
        challenge.status !== "pending" ||
        seen.has(challenge.deviceId)
      ) {
        continue;
      }
      seen.add(challenge.deviceId);
      devices.push(pendingRecord(challenge));
    }
    devices.sort((left, right) => (left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0));
    return devices;
  }

  deviceForPrincipal(servicePrincipal: string, deviceId: string): DeviceControlRecord {
    assertDeviceId(deviceId);
    assertServicePrincipal(servicePrincipal);
    const owner = this.principals.get(deviceId);
    if (owner === servicePrincipal) {
      return this.deviceRecord(deviceId);
    }
    if (owner !== undefined) {
      throw new ControlPlaneError("pair_owned", "device is owned by another service principal");
    }
    const pending = latestPending(this.pairChallenges, deviceId, servicePrincipal);
    if (pending) {
      return pendingRecord(pending);
    }
    throw new ControlPlaneError("pair_unowned", "device ownership has not been verified");
  }

  /**
   * Stores a grant that OpenBot already issued.
   * Does not call the local `authorizationRef` generator.
   */
  applyVerifiedGrant(servicePrincipal: string, grant: VerifiedGrantBinding): DeviceControlRecord {
    this.refreshFromAuthoritativeStore();
    this.assertOwned(servicePrincipal, grant.deviceId);
    if (this.claimStatus(grant.deviceId) !== "claimed") {
      throw new ControlPlaneError("pair_unredeemed", "device ownership has not been verified");
    }
    return this.writeVerifiedGrant(grant);
  }

  /**
   * Updates a binding from a freshly read OpenBot grant.
   * A higher `bindingVersion` is a rebind. The `authorizationRef` stays the grant's value.
   */
  syncVerifiedGrant(servicePrincipal: string, grant: VerifiedGrantBinding): DeviceControlRecord {
    this.refreshFromAuthoritativeStore();
    this.assertOwned(servicePrincipal, grant.deviceId);
    if (!this.bindings.has(grant.deviceId)) {
      throw new ControlPlaneError("bind_missing", "device is not bound");
    }
    return this.writeVerifiedGrant(grant);
  }

  /** Local stop. Does not call OpenBot revoke. Repeat calls stay revoked. */
  revokeForPrincipal(servicePrincipal: string, deviceId: string): DeviceControlRecord & { clearedTokens: number } {
    this.refreshFromAuthoritativeStore();
    this.assertOwned(servicePrincipal, deviceId);
    if (!this.bindings.has(deviceId)) {
      throw new ControlPlaneError("bind_missing", "device is not bound");
    }
    if (this.revoked.has(deviceId)) {
      return { ...this.deviceRecord(deviceId), clearedTokens: 0 };
    }
    const clearedTokens = this.revoke(deviceId).clearedTokens;
    return { ...this.deviceRecord(deviceId), clearedTokens };
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

  private assertOwned(servicePrincipal: string, deviceId: string): void {
    assertDeviceId(deviceId);
    assertServicePrincipal(servicePrincipal);
    const owner = this.principals.get(deviceId);
    if (owner === undefined) {
      throw new ControlPlaneError("pair_unowned", "device ownership has not been verified");
    }
    if (owner !== servicePrincipal) {
      throw new ControlPlaneError("pair_owned", "device is owned by another service principal");
    }
  }

  private writeVerifiedGrant(grant: VerifiedGrantBinding): DeviceControlRecord {
    const binding = bindingFromVerifiedGrant(grant);
    const current = this.bindings.get(binding.deviceId);
    if (grant.status === "revoked") {
      if (!current) {
        throw new ControlPlaneError("grant_revoked", "OpenBot grant is revoked");
      }
      if (current.authorizationRef !== binding.authorizationRef) {
        throw new ControlPlaneError("grant_ref", "grant authorizationRef does not match the stored binding");
      }
      if (!this.revoked.has(binding.deviceId)) {
        this.revoke(binding.deviceId);
      }
      return this.deviceRecord(binding.deviceId);
    }
    if (grant.status !== undefined && grant.status !== "active") {
      throw new ControlPlaneError("grant_status", "grant status is not active or revoked");
    }
    if (current && current.authorizationRef !== binding.authorizationRef) {
      throw new ControlPlaneError("grant_ref", "grant authorizationRef does not match the stored binding");
    }
    if (current && binding.bindingVersion < current.bindingVersion) {
      throw new ControlPlaneError("grant_stale", "grant bindingVersion is older than the stored binding");
    }
    if (current && this.revoked.has(binding.deviceId) && binding.bindingVersion <= current.bindingVersion) {
      throw new ControlPlaneError("bind_revoked", "device stays stopped until OpenBot increases bindingVersion");
    }
    const versionChanged = current !== undefined && current.bindingVersion !== binding.bindingVersion;
    const profileChanged =
      current === undefined ||
      versionChanged ||
      current.digitalHumanId !== binding.digitalHumanId ||
      !assistantEqual(current.assistant, binding.assistant);
    if (profileChanged) {
      if (versionChanged) {
        this.dropCredentials(binding.deviceId);
        this.notifySessions(binding.deviceId, "rebound");
      }
      this.revoked.delete(binding.deviceId);
      this.bindings.set(binding.deviceId, binding);
      this.grantBound.add(binding.deviceId);
      if (current) {
        invalidateDigitalHumanCache(this);
      }
      this.persist();
    } else if (!this.grantBound.has(binding.deviceId)) {
      this.grantBound.add(binding.deviceId);
      this.persist();
    }
    return this.deviceRecord(binding.deviceId);
  }

  private deviceRecord(deviceId: string): DeviceControlRecord {
    const servicePrincipal = this.principals.get(deviceId);
    if (servicePrincipal === undefined) {
      throw new ControlPlaneError("pair_unowned", "device ownership has not been verified");
    }
    const pending = latestPending(this.pairChallenges, deviceId, servicePrincipal);
    const binding = this.bindings.get(deviceId);
    const revoked = this.revoked.has(deviceId);
    const bindStatus: DeviceBindStatusName = revoked ? "revoked" : binding ? "bound" : "unbound";
    const base: DeviceControlRecord = {
      deviceId,
      servicePrincipal,
      ownership: pending ? "pending" : "verified",
      bindStatus,
      revoked,
      ...(pending ? { pairChallenge: pending.pairChallenge } : {}),
    };
    if (!binding) {
      return base;
    }
    const withBinding: DeviceControlRecord = {
      ...base,
      authorizationRef: binding.authorizationRef,
      bindingVersion: binding.bindingVersion,
      digitalHumanId: binding.digitalHumanId,
      assistant: cloneAssistant(binding.assistant),
    };
    if (!this.grantBound.has(deviceId)) {
      return withBinding;
    }
    return { ...withBinding, source: "openbot-grant" };
  }

  /**
   * Reload Maps from the durable store. Security-sensitive paths call this so a
   * peer ControlPlane's revoke/rebind is visible without sharing one process instance.
   */
  private refreshFromAuthoritativeStore(): void {
    if (!this.store) {
      return;
    }
    this.hydrate();
  }

  private hydrate(): void {
    if (!this.store) {
      return;
    }
    this.storeRevision = this.store.revision(STAGING_CONTROL_SECTION);
    const raw = this.store.get(STAGING_CONTROL_SECTION);
    if (raw === undefined) {
      this.claims.clear();
      this.bindings.clear();
      this.ota.clear();
      this.credentials.clear();
      this.revoked.clear();
      this.pairChallenges.clear();
      this.principals.clear();
      this.grantBound.clear();
      return;
    }
    const section = parseControlSection(raw);
    this.claims.clear();
    this.bindings.clear();
    this.ota.clear();
    this.credentials.clear();
    this.revoked.clear();
    this.pairChallenges.clear();
    this.principals.clear();
    this.grantBound.clear();
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
    for (const challenge of section.pairChallenges) {
      this.pairChallenges.set(challenge.pairChallenge, challenge);
    }
    for (const principal of section.devicePrincipals) {
      this.principals.set(principal.deviceId, principal.servicePrincipal);
    }
    for (const deviceId of section.grantBound) {
      this.grantBound.add(deviceId);
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
      pairChallenges: [...this.pairChallenges.values()].map((challenge) => ({ ...challenge })),
      devicePrincipals: [...this.principals.entries()].map(([deviceId, servicePrincipal]) => ({
        deviceId,
        servicePrincipal,
      })),
      grantBound: [...this.grantBound],
    };
    try {
      this.store.set(STAGING_CONTROL_SECTION, section, this.storeRevision);
    } catch (error) {
      if (error instanceof StagingConflictError) {
        this.refreshFromAuthoritativeStore();
        throw new ControlPlaneError(
          "state_conflict",
          "control-plane store was updated concurrently; retry the mutation",
        );
      }
      throw error;
    }
    this.storeRevision = this.store.revision(STAGING_CONTROL_SECTION);
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
  const pairChallenges = raw.pairChallenges === undefined ? [] : parsePairChallenges(raw.pairChallenges);
  const devicePrincipals = raw.devicePrincipals === undefined ? [] : parseDevicePrincipals(raw.devicePrincipals);
  const grantBound = raw.grantBound === undefined ? [] : parseGrantBound(raw.grantBound);
  return { version: STATE_VERSION, claims, bindings, ota, credentials, revoked, pairChallenges, devicePrincipals, grantBound };
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

function ownershipOf(challenge: PairChallengeRecord): PairOwnership {
  return {
    pairChallenge: challenge.pairChallenge,
    deviceId: challenge.deviceId,
    servicePrincipal: challenge.servicePrincipal,
    status: "redeemed",
    ownership: "verified",
  };
}

function pendingRecord(challenge: PairChallengeRecord): DeviceControlRecord {
  return {
    deviceId: challenge.deviceId,
    servicePrincipal: challenge.servicePrincipal,
    ownership: "pending",
    bindStatus: "unbound",
    revoked: false,
    pairChallenge: challenge.pairChallenge,
  };
}

function latestPending(
  challenges: ReadonlyMap<string, PairChallengeRecord>,
  deviceId: string,
  servicePrincipal: string,
): PairChallengeRecord | undefined {
  let found: PairChallengeRecord | undefined;
  for (const challenge of challenges.values()) {
    if (challenge.deviceId === deviceId && challenge.servicePrincipal === servicePrincipal && challenge.status === "pending") {
      found = challenge;
    }
  }
  return found;
}

function bindingFromVerifiedGrant(grant: VerifiedGrantBinding): FrozenBinding {
  assertAssistantHasNoPairFields(grant.assistant);
  return assertFrozenBinding({
    authorizationRef: grant.authorizationRef,
    bindingVersion: grant.bindingVersion,
    digitalHumanId: grant.digitalHumanId,
    deviceId: grant.deviceId,
    assistant: grant.assistant,
  });
}

function assertAssistantHasNoPairFields(assistant: AssistantFields): void {
  for (const key of Object.keys(assistant)) {
    if (PAIRING_FIELD_NAMES.has(key)) {
      throw new ControlPlaneError("pair_field", "pair fields are not part of an OpenBot grant");
    }
  }
}

function assertDeviceId(deviceId: string): void {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new ControlPlaneError("pair_device", "deviceId is invalid");
  }
}

function assertServicePrincipal(servicePrincipal: string): void {
  if (!SERVICE_PRINCIPAL_PATTERN.test(servicePrincipal)) {
    throw new ControlPlaneError("pair_principal", "service principal is invalid");
  }
}

function parsePairChallenges(value: unknown): PairChallengeRecord[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("state_corrupt", "pair challenges must be an array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isPlainObject(item)) {
      throw new ControlPlaneError("state_corrupt", "pair challenge must be an object");
    }
    const { pairChallenge, deviceId, pairingCode, expiresAtMs, status, servicePrincipal, redeemedAtMs } = item;
    if (typeof pairChallenge !== "string" || !PAIR_CHALLENGE_PATTERN.test(pairChallenge) || seen.has(pairChallenge)) {
      throw new ControlPlaneError("state_corrupt", "pair challenge id is invalid");
    }
    if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
      throw new ControlPlaneError("state_corrupt", "pair challenge deviceId is invalid");
    }
    if (typeof pairingCode !== "string" || !/^\d{6}$/.test(pairingCode)) {
      throw new ControlPlaneError("state_corrupt", "pairing code must be 6 digits");
    }
    if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) {
      throw new ControlPlaneError("state_corrupt", "pair challenge expiry is invalid");
    }
    if (status !== "pending" && status !== "redeemed") {
      throw new ControlPlaneError("state_corrupt", "pair challenge status is invalid");
    }
    if (typeof servicePrincipal !== "string" || !SERVICE_PRINCIPAL_PATTERN.test(servicePrincipal)) {
      throw new ControlPlaneError("state_corrupt", "pair challenge principal is invalid");
    }
    if (redeemedAtMs !== undefined && (typeof redeemedAtMs !== "number" || !Number.isFinite(redeemedAtMs))) {
      throw new ControlPlaneError("state_corrupt", "pair challenge redeem time is invalid");
    }
    seen.add(pairChallenge);
    const record: PairChallengeRecord = {
      pairChallenge,
      deviceId,
      pairingCode,
      expiresAtMs,
      status,
      servicePrincipal,
    };
    if (typeof redeemedAtMs === "number") {
      record.redeemedAtMs = redeemedAtMs;
    }
    return record;
  });
}

function parseDevicePrincipals(value: unknown): DevicePrincipalRecord[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("state_corrupt", "device principals must be an array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isPlainObject(item)) {
      throw new ControlPlaneError("state_corrupt", "device principal must be an object");
    }
    const { deviceId, servicePrincipal } = item;
    if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId) || seen.has(deviceId)) {
      throw new ControlPlaneError("state_corrupt", "device principal deviceId is invalid");
    }
    if (typeof servicePrincipal !== "string" || !SERVICE_PRINCIPAL_PATTERN.test(servicePrincipal)) {
      throw new ControlPlaneError("state_corrupt", "device principal is invalid");
    }
    seen.add(deviceId);
    return { deviceId, servicePrincipal };
  });
}

function parseGrantBound(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ControlPlaneError("state_corrupt", "grant bindings must be an array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (typeof item !== "string" || !DEVICE_ID_PATTERN.test(item) || seen.has(item)) {
      throw new ControlPlaneError("state_corrupt", "grant-bound deviceId is invalid");
    }
    seen.add(item);
    return item;
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
