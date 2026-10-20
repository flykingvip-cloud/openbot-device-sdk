import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ControlPlane } from "./control-plane.ts";

/** Device-platform prefix. Not `/api/integrations/v1`. */
export const DEVICE_CONTROL_PREFIX = "/api/device-control/v1";

export const DEVICE_CONTROL_PROTOCOL = "device-control.v1";

export const PAIR_TTL_MS = 60_000;

export const PAIR_ATTEMPT_LIMIT = 3;

/**
 * Three entries for OpenBot「设备与硬件」. Names are a draft for Agent B to freeze.
 * They are not OpenBot integration fields.
 */
export const HARDWARE_ENTRIES = [
  { id: "device-control.discover", title: "设备发现" },
  { id: "device-control.pair", title: "设备配对" },
  { id: "device-control.control", title: "绑定与状态" },
] as const;

export const SUPPORTED_FEATURES = [
  "health",
  "capabilities",
  "pair-challenge",
  "device-query",
  "apply-binding",
  "stop-revoke",
  "status-sync",
] as const;

const BROWSER_IDENTITY_FIELDS = ["userSubject", "tenantId", "digitalHumanId", "userId", "initiator"] as const;

const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export class DeviceControlError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DeviceControlError";
    this.status = status;
    this.code = code;
  }
}

export interface ServiceClient {
  clientId: string;
  secret: string;
}

export type ApplyStatus = "accepted" | "applying" | "active" | "failed";

export interface PairChallenge {
  challengeId: string;
  deviceId: string;
  initiator: string;
  expiresAtMs: number;
  /** Present only on create. Verify uses the same value once. */
  secret?: string;
}

export interface DeviceSummary {
  deviceId: string;
  subject: string;
  paired: boolean;
  stopped: boolean;
  applyStatus: ApplyStatus | null;
}

export interface BindingView {
  deviceId: string;
  authorizationRef: string;
  bindingVersion: number;
  applyStatus: ApplyStatus;
  restrictedAuthStored: boolean;
  failure: string | null;
}

export interface StopReport {
  deviceId: string;
  sessionsStopped: number;
  playStopped: boolean;
  toolsStopped: number;
  credentialsCleared: boolean;
  controlPlaneClearedTokens: number | null;
}

export interface StatusSnapshot {
  deviceId: string;
  eventId: string;
  version: number;
  online: boolean;
  lastSeen: string;
  capabilities: string[];
  firmware: string;
  firmwareUrl: null;
  duplicate: boolean;
}

export interface DeviceControlServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

interface ChallengeRecord {
  challengeId: string;
  deviceId: string;
  initiator: string;
  secret: string;
  expiresAtMs: number;
  attempts: number;
  consumed: boolean;
  locked: boolean;
}

interface BindingRecord {
  authorizationRef: string;
  bindingVersion: number;
  applyStatus: ApplyStatus;
  restrictedAuth: string | null;
  failure: string | null;
}

interface StatusRecord {
  eventId: string;
  version: number;
  digest: string;
  online: boolean;
  lastSeen: string;
  capabilities: string[];
  firmware: string;
}

interface OwnedDevice {
  deviceId: string;
  subject: string;
  paired: boolean;
  stopped: boolean;
  sessions: number;
  playing: boolean;
  tools: number;
  binding: BindingRecord | undefined;
  status: StatusRecord | undefined;
}

export interface ApplyBindingInput {
  authorizationRef: string;
  bindingVersion: number;
  restrictedAuth: string;
}

export interface StatusSyncInput {
  eventId: string;
  version: number;
  online: boolean;
  lastSeen: string;
  capabilities: string[];
  firmware: string;
}

/**
 * Lab device-control API. The authenticated service client is the subject.
 * Request bodies cannot choose user, tenant, or digitalHuman identity.
 * Pairing state stays here and is not an OpenBot field.
 */
export class DeviceControl {
  private readonly now: () => number;
  private readonly clients: ServiceClient[];
  private readonly plane: ControlPlane | undefined;
  private readonly nextChallengeId: () => string;
  private readonly nextSecret: () => string;
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly devices = new Map<string, OwnedDevice>();
  private challengeSerial = 0;

  constructor(
    options: {
      clients: ServiceClient[];
      now?: () => number;
      plane?: ControlPlane;
      challengeId?: () => string;
      secret?: () => string;
    },
  ) {
    if (options.clients.length === 0) {
      throw new DeviceControlError(500, "service_client", "at least one service client is required");
    }
    for (const client of options.clients) {
      if (client.clientId.length === 0 || client.clientId.includes(":")) {
        throw new DeviceControlError(500, "service_client", "service clientId is empty or contains ':'");
      }
      if (client.secret.length < 16) {
        throw new DeviceControlError(500, "service_client", "service client secret must be at least 16 characters");
      }
    }
    this.clients = options.clients.map((client) => ({ clientId: client.clientId, secret: client.secret }));
    this.now = options.now ?? Date.now;
    this.plane = options.plane;
    this.nextChallengeId = options.challengeId ?? (() => {
      this.challengeSerial += 1;
      return `pch_${this.challengeSerial}`;
    });
    this.nextSecret = options.secret ?? (() => randomBytes(24).toString("base64url"));
  }

  authenticate(authorization: string | undefined): string {
    const parsed = parseBasic(authorization);
    if (parsed === undefined) {
      throw new DeviceControlError(401, "service_auth", "service basic is required");
    }
    const client = this.clients.find((item) => item.clientId === parsed.clientId);
    if (client === undefined || !secretEquals(client.secret, parsed.secret)) {
      throw new DeviceControlError(401, "service_auth", "service basic was rejected");
    }
    return client.clientId;
  }

  health(): { ok: true; protocol: typeof DEVICE_CONTROL_PROTOCOL; firmwareUrl: null; executable: false } {
    return { ok: true, protocol: DEVICE_CONTROL_PROTOCOL, firmwareUrl: null, executable: false };
  }

  capabilities(): {
    protocol: typeof DEVICE_CONTROL_PROTOCOL;
    entries: typeof HARDWARE_ENTRIES;
    features: typeof SUPPORTED_FEATURES;
    firmwareUrl: null;
    flash: false;
    massFlash: false;
    connector: "see draft PR #10; this process does not call the longitudinal connector";
  } {
    return {
      protocol: DEVICE_CONTROL_PROTOCOL,
      entries: HARDWARE_ENTRIES,
      features: SUPPORTED_FEATURES,
      firmwareUrl: null,
      flash: false,
      massFlash: false,
      connector: "see draft PR #10; this process does not call the longitudinal connector",
    };
  }

  createPairChallenge(subject: string, deviceId: string): PairChallenge {
    assertDeviceId(deviceId);
    const existing = this.devices.get(deviceId);
    if (existing !== undefined && existing.subject !== subject) {
      throw new DeviceControlError(403, "device_owned", "device is owned by another service subject");
    }
    const challengeId = this.nextChallengeId();
    const secret = this.nextSecret();
    const record: ChallengeRecord = {
      challengeId,
      deviceId,
      initiator: subject,
      secret,
      expiresAtMs: this.now() + PAIR_TTL_MS,
      attempts: 0,
      consumed: false,
      locked: false,
    };
    this.challenges.set(challengeId, record);
    if (existing === undefined) {
      this.devices.set(deviceId, emptyDevice(deviceId, subject));
    }
    return { challengeId, deviceId, initiator: subject, expiresAtMs: record.expiresAtMs, secret };
  }

  verifyPairChallenge(subject: string, challengeId: string, deviceId: string, secret: string): { paired: true } {
    const challenge = this.challenges.get(challengeId);
    if (challenge === undefined || challenge.initiator !== subject) {
      throw new DeviceControlError(404, "challenge_missing", "pair challenge was not found");
    }
    if (challenge.deviceId !== deviceId) {
      throw new DeviceControlError(403, "challenge_device", "pair challenge is bound to another device");
    }
    if (challenge.consumed) {
      throw new DeviceControlError(409, "challenge_used", "pair challenge was already used");
    }
    if (challenge.locked || challenge.attempts >= PAIR_ATTEMPT_LIMIT) {
      challenge.locked = true;
      throw new DeviceControlError(403, "challenge_locked", "pair challenge attempt limit was reached");
    }
    if (this.now() >= challenge.expiresAtMs) {
      throw new DeviceControlError(403, "challenge_expired", "pair challenge expired");
    }
    if (!secretEquals(challenge.secret, secret)) {
      challenge.attempts += 1;
      if (challenge.attempts >= PAIR_ATTEMPT_LIMIT) {
        challenge.locked = true;
      }
      throw new DeviceControlError(401, "challenge_secret", "pair challenge secret was rejected");
    }
    challenge.consumed = true;
    const device = this.devices.get(deviceId) ?? emptyDevice(deviceId, subject);
    device.paired = true;
    device.stopped = false;
    this.devices.set(deviceId, device);
    return { paired: true };
  }

  listDevices(subject: string): DeviceSummary[] {
    return [...this.devices.values()]
      .filter((device) => device.subject === subject && device.paired)
      .map((device) => summarize(device));
  }

  getDevice(subject: string, deviceId: string): DeviceSummary {
    const device = this.record(subject, deviceId);
    if (!device.paired && !device.stopped) {
      throw new DeviceControlError(404, "device_missing", "device was not found for this service subject");
    }
    return summarize(device);
  }

  applyBinding(
    subject: string,
    deviceId: string,
    input: ApplyBindingInput,
    hooks: { onStatus?: (status: ApplyStatus) => void } = {},
  ): BindingView {
    const device = this.record(subject, deviceId);
    if (!device.paired || device.stopped) {
      throw new DeviceControlError(403, "pair_required", "device must be paired before apply");
    }
    const failure = bindingFailure(input);
    if (failure !== undefined) {
      device.binding = {
        authorizationRef: input.authorizationRef,
        bindingVersion: Number.isInteger(input.bindingVersion) ? input.bindingVersion : 0,
        applyStatus: "failed",
        restrictedAuth: null,
        failure,
      };
      hooks.onStatus?.("failed");
      return bindingView(device);
    }
    device.binding = {
      authorizationRef: input.authorizationRef,
      bindingVersion: input.bindingVersion,
      applyStatus: "accepted",
      restrictedAuth: input.restrictedAuth,
      failure: null,
    };
    hooks.onStatus?.("accepted");
    device.binding.applyStatus = "applying";
    hooks.onStatus?.("applying");
    device.binding.applyStatus = "active";
    hooks.onStatus?.("active");
    return bindingView(device);
  }

  getBinding(subject: string, deviceId: string): BindingView {
    const device = this.record(subject, deviceId);
    if (device.binding === undefined) {
      throw new DeviceControlError(404, "binding_missing", "binding has not been applied");
    }
    return bindingView(device);
  }

  noteActivity(subject: string, deviceId: string, kind: "session" | "play" | "tool"): void {
    const device = this.record(subject, deviceId);
    if (!device.paired || device.stopped) {
      throw new DeviceControlError(403, "device_stopped", "device is stopped");
    }
    if (kind === "session") {
      device.sessions += 1;
      return;
    }
    if (kind === "play") {
      device.playing = true;
      return;
    }
    device.tools += 1;
  }

  stop(subject: string, deviceId: string): StopReport {
    const device = this.record(subject, deviceId);
    if (!device.paired) {
      throw new DeviceControlError(device.stopped ? 403 : 404, device.stopped ? "device_stopped" : "device_missing", "device is not paired");
    }
    const sessionsStopped = device.sessions;
    const playStopped = device.playing;
    const toolsStopped = device.tools;
    const credentialsCleared = device.binding?.restrictedAuth != null;
    device.sessions = 0;
    device.playing = false;
    device.tools = 0;
    device.stopped = true;
    device.paired = false;
    if (device.binding !== undefined) {
      device.binding.restrictedAuth = null;
    }
    let controlPlaneClearedTokens: number | null = null;
    if (this.plane?.getBinding(deviceId) !== undefined) {
      controlPlaneClearedTokens = this.plane.revoke(deviceId).clearedTokens;
    }
    return {
      deviceId,
      sessionsStopped,
      playStopped,
      toolsStopped,
      credentialsCleared,
      controlPlaneClearedTokens,
    };
  }

  syncStatus(subject: string, deviceId: string, input: StatusSyncInput): StatusSnapshot {
    const device = this.record(subject, deviceId);
    if (device.stopped || !device.paired) {
      throw new DeviceControlError(403, "device_stopped", "status sync requires a paired device");
    }
    assertStatus(input);
    const digest = statusDigest(input);
    const previous = device.status;
    if (previous !== undefined && previous.eventId === input.eventId) {
      if (previous.digest !== digest) {
        throw new DeviceControlError(409, "status_conflict", "eventId was already used for a different status");
      }
      return statusView(deviceId, previous, true);
    }
    if (previous !== undefined && input.version <= previous.version) {
      throw new DeviceControlError(409, "status_version", "status version must increase");
    }
    const stored: StatusRecord = {
      eventId: input.eventId,
      version: input.version,
      digest,
      online: input.online,
      lastSeen: input.lastSeen,
      capabilities: [...input.capabilities],
      firmware: input.firmware,
    };
    device.status = stored;
    return statusView(deviceId, stored, false);
  }

  getStatus(subject: string, deviceId: string): StatusSnapshot {
    const device = this.record(subject, deviceId);
    if (device.status === undefined) {
      throw new DeviceControlError(404, "status_missing", "status has not been synced");
    }
    return statusView(deviceId, device.status, false);
  }

  private record(subject: string, deviceId: string): OwnedDevice {
    assertDeviceId(deviceId);
    const device = this.devices.get(deviceId);
    if (device === undefined || device.subject !== subject) {
      throw new DeviceControlError(404, "device_missing", "device was not found for this service subject");
    }
    return device;
  }
}

export function assertDeviceControlLoopback(host: string): void {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!LOOPBACK_HOSTS.has(bare.toLowerCase())) {
    throw new DeviceControlError(400, "loopback", "device-control refuses non-loopback hosts");
  }
}

export function rejectBrowserIdentity(value: Record<string, unknown>): void {
  for (const field of BROWSER_IDENTITY_FIELDS) {
    if (field in value) {
      throw new DeviceControlError(400, "browser_identity", `${field} is not accepted as caller identity`);
    }
  }
}

export function startDeviceControlServer(
  control: DeviceControl,
  options: { host?: string; port?: number } = {},
): Promise<DeviceControlServer> {
  const host = options.host ?? "127.0.0.1";
  assertDeviceControlLoopback(host);
  const port = options.port ?? 0;
  const server = createServer((req, res) => {
    void handleDeviceControl(control, req, res).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal" });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new DeviceControlError(500, "listen", "device-control server has no port"));
        return;
      }
      const advertised = host === "::" ? "[::1]" : host;
      resolve({
        url: `http://${advertised.includes(":") ? `[${advertised}]` : advertised}:${address.port}`,
        port: address.port,
        close: () => closeServer(server),
      });
    });
  });
}

export async function handleDeviceControl(control: DeviceControl, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!peerIsLoopback(req)) {
    writeJson(res, 403, { error: "loopback" });
    return;
  }
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (!path.startsWith(DEVICE_CONTROL_PREFIX)) {
    writeJson(res, 404, { error: "not_found" });
    return;
  }
  let subject: string;
  try {
    subject = control.authenticate(headerValue(req, "authorization"));
  } catch (error) {
    writeError(res, error);
    return;
  }
  const route = path.slice(DEVICE_CONTROL_PREFIX.length);
  try {
    if (route === "/health" && req.method === "GET") {
      writeJson(res, 200, control.health());
      return;
    }
    if (route === "/capabilities" && req.method === "GET") {
      writeJson(res, 200, control.capabilities());
      return;
    }
    if (route === "/pair-challenges" && req.method === "POST") {
      const body = await readJson(req);
      rejectBrowserIdentity(body);
      const deviceId = requiredString(body, "deviceId");
      writeJson(res, 201, control.createPairChallenge(subject, deviceId));
      return;
    }
    const verify = /^\/pair-challenges\/([^/]+)\/verify$/.exec(route);
    if (verify?.[1] !== undefined && req.method === "POST") {
      const body = await readJson(req);
      rejectBrowserIdentity(body);
      writeJson(res, 200, control.verifyPairChallenge(subject, decodeURIComponent(verify[1]), requiredString(body, "deviceId"), requiredString(body, "secret")));
      return;
    }
    if (route === "/devices" && req.method === "GET") {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      rejectBrowserIdentity(Object.fromEntries(url.searchParams.entries()));
      writeJson(res, 200, { devices: control.listDevices(subject) });
      return;
    }
    const binding = /^\/devices\/([^/]+)\/binding$/.exec(route);
    if (binding?.[1] !== undefined) {
      const deviceId = decodeURIComponent(binding[1]);
      if (req.method === "GET") {
        writeJson(res, 200, control.getBinding(subject, deviceId));
        return;
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        rejectBrowserIdentity(body);
        writeJson(res, 200, control.applyBinding(subject, deviceId, {
          authorizationRef: requiredString(body, "authorizationRef"),
          bindingVersion: requiredInteger(body, "bindingVersion"),
          restrictedAuth: requiredString(body, "restrictedAuth"),
        }));
        return;
      }
    }
    const revoke = /^\/devices\/([^/]+)\/revoke$/.exec(route);
    if (revoke?.[1] !== undefined && req.method === "POST") {
      rejectBrowserIdentity(await readJson(req));
      writeJson(res, 200, control.stop(subject, decodeURIComponent(revoke[1])));
      return;
    }
    const status = /^\/devices\/([^/]+)\/status$/.exec(route);
    if (status?.[1] !== undefined) {
      const deviceId = decodeURIComponent(status[1]);
      if (req.method === "GET") {
        writeJson(res, 200, control.getStatus(subject, deviceId));
        return;
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        rejectBrowserIdentity(body);
        if ("firmwareUrl" in body) {
          throw new DeviceControlError(400, "firmware_url", "firmwareUrl is not accepted");
        }
        writeJson(res, 200, control.syncStatus(subject, deviceId, {
          eventId: requiredString(body, "eventId"),
          version: requiredInteger(body, "version"),
          online: requiredBoolean(body, "online"),
          lastSeen: requiredString(body, "lastSeen"),
          capabilities: requiredStringList(body, "capabilities"),
          firmware: requiredString(body, "firmware"),
        }));
        return;
      }
    }
    const one = /^\/devices\/([^/]+)$/.exec(route);
    if (one?.[1] !== undefined && req.method === "GET") {
      writeJson(res, 200, control.getDevice(subject, decodeURIComponent(one[1])));
      return;
    }
    writeJson(res, 404, { error: "not_found" });
  } catch (error) {
    writeError(res, error);
  }
}

function emptyDevice(deviceId: string, subject: string): OwnedDevice {
  return {
    deviceId,
    subject,
    paired: false,
    stopped: false,
    sessions: 0,
    playing: false,
    tools: 0,
    binding: undefined,
    status: undefined,
  };
}

function summarize(device: OwnedDevice): DeviceSummary {
  return {
    deviceId: device.deviceId,
    subject: device.subject,
    paired: device.paired,
    stopped: device.stopped,
    applyStatus: device.binding?.applyStatus ?? null,
  };
}

function bindingView(device: OwnedDevice): BindingView {
  const binding = device.binding;
  if (binding === undefined) {
    throw new DeviceControlError(404, "binding_missing", "binding has not been applied");
  }
  return {
    deviceId: device.deviceId,
    authorizationRef: binding.authorizationRef,
    bindingVersion: binding.bindingVersion,
    applyStatus: binding.applyStatus,
    restrictedAuthStored: binding.restrictedAuth !== null && binding.restrictedAuth.length > 0,
    failure: binding.failure,
  };
}

function bindingFailure(input: ApplyBindingInput): string | undefined {
  if (input.authorizationRef.length === 0) {
    return "authorizationRef is required";
  }
  if (!Number.isInteger(input.bindingVersion) || input.bindingVersion < 1) {
    return "bindingVersion must be an integer >= 1";
  }
  if (input.restrictedAuth.length < 16) {
    return "restrictedAuth must be at least 16 characters";
  }
  return undefined;
}

function assertStatus(input: StatusSyncInput): void {
  if (input.eventId.length === 0 || !Number.isInteger(input.version) || input.version < 1) {
    throw new DeviceControlError(400, "status_invalid", "eventId and version are required");
  }
  if (Number.isNaN(Date.parse(input.lastSeen))) {
    throw new DeviceControlError(400, "status_invalid", "lastSeen must be a timestamp");
  }
  if (input.firmware.includes("://") || /tenclass/i.test(input.firmware)) {
    throw new DeviceControlError(400, "firmware_url", "firmware is a label, not a URL");
  }
  if (input.capabilities.some((name) => name === "ota.flash" || name === "ota.massFlash")) {
    throw new DeviceControlError(400, "flash_disabled", "flash and massFlash are not device-control features");
  }
}

function statusDigest(input: StatusSyncInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      eventId: input.eventId,
      version: input.version,
      online: input.online,
      lastSeen: input.lastSeen,
      capabilities: input.capabilities,
      firmware: input.firmware,
    }))
    .digest("hex");
}

function statusView(deviceId: string, record: StatusRecord, duplicate: boolean): StatusSnapshot {
  return {
    deviceId,
    eventId: record.eventId,
    version: record.version,
    online: record.online,
    lastSeen: record.lastSeen,
    capabilities: [...record.capabilities],
    firmware: record.firmware,
    firmwareUrl: null,
    duplicate,
  };
}

function assertDeviceId(deviceId: string): void {
  if (!DEVICE_ID.test(deviceId)) {
    throw new DeviceControlError(400, "device_id", "deviceId is invalid");
  }
}

function parseBasic(header: string | undefined): { clientId: string; secret: string } | undefined {
  if (header === undefined || !header.startsWith("Basic ")) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const split = decoded.indexOf(":");
  if (split <= 0) {
    return undefined;
  }
  return { clientId: decoded.slice(0, split), secret: decoded.slice(split + 1) };
}

function secretEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function peerIsLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new DeviceControlError(400, "body", `${key} must be a string`);
  }
  return value;
}

function requiredInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DeviceControlError(400, "body", `${key} must be an integer`);
  }
  return value;
}

function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") {
    throw new DeviceControlError(400, "body", `${key} must be a boolean`);
  }
  return value;
}

function requiredStringList(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DeviceControlError(400, "body", `${key} must be a string list`);
  }
  return value;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (text.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new DeviceControlError(400, "body", "body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DeviceControlError(400, "body", "body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(new DeviceControlError(400, "body", "body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof DeviceControlError) {
    writeJson(res, error.status, { error: error.code });
    return;
  }
  writeJson(res, 500, { error: "internal" });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
