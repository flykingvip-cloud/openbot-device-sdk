import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  FrozenFieldError,
  GRANT_CREDENTIAL_HEADER,
  INTEGRATIONS_API_PREFIX,
  assertJsonValue,
  isPlainObject,
  serviceBasicFromEnv,
  stubLocationFromEnv,
  type AssistantFields,
} from "../../contracts/src/index.ts";
import { readGrant } from "../../integrations/openbot-longitudinal/src/index.ts";
import { ControlPlane, type VerifiedGrantBinding } from "./control-plane.ts";
import { ControlPlaneError } from "./errors.ts";
import { assertLabLoopbackHost } from "./ota-config.ts";

/** Device-platform control surface. Not `/api/integrations/v1`. */
export const DEVICE_CONTROL_API_PREFIX = "/api/device-platform/v1";

export const DEVICE_CONTROL_ROUTES = [
  "GET /api/device-platform/v1/health",
  "GET /api/device-platform/v1/capabilities",
  "POST /api/device-platform/v1/pair-challenges",
  "POST /api/device-platform/v1/pair-challenges/{pairChallenge}/redeem",
  "GET /api/device-platform/v1/devices",
  "POST /api/device-platform/v1/devices/{deviceId}/bind",
  "GET /api/device-platform/v1/devices/{deviceId}/bind",
  "POST /api/device-platform/v1/devices/{deviceId}/bind/sync",
  "POST /api/device-platform/v1/devices/{deviceId}/revoke",
  "POST /api/device-platform/v1/devices/{deviceId}/stop",
] as const;

const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PAIR_CHALLENGE = /^pch_[A-Za-z0-9_-]{8,80}$/;
const SERVICE_PRINCIPAL = /^[A-Za-z0-9_.:@-]{1,128}$/;
const IDENTITY_KEYS = new Set(["userId", "tenantId", "userSubject", "user_id", "tenant_id", "digitalHumanId"]);
const PAIR_KEYS = new Set(["pairChallenge", "pairingChallenge", "pairingCode", "ownershipProof", "pairNonce"]);
const SECRET_KEYS = new Set(["authorizationCredential", "authorizationCode", "codeVerifier"]);

const PAIR_REDEEM = /^\/api\/device-platform\/v1\/pair-challenges\/([^/]+)\/redeem$/;
const DEVICE_BIND = /^\/api\/device-platform\/v1\/devices\/([^/]+)\/bind$/;
const DEVICE_SYNC = /^\/api\/device-platform\/v1\/devices\/([^/]+)\/bind\/sync$/;
const DEVICE_STOP = /^\/api\/device-platform\/v1\/devices\/([^/]+)\/(?:revoke|stop)$/;

export interface DeviceControlHealth {
  ok: true;
  service: "device-control";
  apiPrefix: typeof DEVICE_CONTROL_API_PREFIX;
  /** Frozen v1 marker for the joint Agent B / OpenBot UI contract. Not gray release and not real-device delivery. */
  maturity: "v1-frozen";
  grayRelease: false;
  realDeviceDelivery: false;
  firmwareUrl: null;
  executable: false;
  flash: false;
  massFlash: false;
}

export interface DeviceControlCapabilities {
  apiPrefix: typeof DEVICE_CONTROL_API_PREFIX;
  audience: "openbot-service-client";
  auth: "serviceBasic";
  browserIdentity: false;
  routes: typeof DEVICE_CONTROL_ROUTES;
  openBot: {
    prefix: typeof INTEGRATIONS_API_PREFIX;
    consent: "pkce-s256";
    grantExchange: "POST /grants/exchange";
    pairFieldsAccepted: false;
  };
  ota: {
    flash: false;
    massFlash: false;
    firmwareUrl: null;
  };
}

export interface ServiceClientCredential {
  user: string;
  password: string;
}

export interface GrantReadInput {
  authorizationRef: string;
  grantCredential: string;
  servicePrincipal: string;
}

/** Reads a grant from OpenBot. The device-control route does not mint `authorizationRef`. */
export interface GrantVerifier {
  readGrant(input: GrantReadInput): Promise<VerifiedGrantBinding>;
}

export interface DeviceControlServerOptions {
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** When omitted, the server accepts the service Basic user from the environment. */
  serviceClients?: readonly ServiceClientCredential[];
  /** When omitted, bind and sync call OpenBot `GET /grants/{authorizationRef}` on the loopback stub. */
  grantVerifier?: GrantVerifier;
  fetchImpl?: typeof fetch;
}

export interface DeviceControlServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export class DeviceControlError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DeviceControlError";
    this.code = code;
    this.status = status;
  }
}

export function deviceControlHealth(): DeviceControlHealth {
  return {
    ok: true,
    service: "device-control",
    apiPrefix: DEVICE_CONTROL_API_PREFIX,
    maturity: "v1-frozen",
    grayRelease: false,
    realDeviceDelivery: false,
    firmwareUrl: null,
    executable: false,
    flash: false,
    massFlash: false,
  };
}

export function deviceControlCapabilities(): DeviceControlCapabilities {
  return {
    apiPrefix: DEVICE_CONTROL_API_PREFIX,
    audience: "openbot-service-client",
    auth: "serviceBasic",
    browserIdentity: false,
    routes: DEVICE_CONTROL_ROUTES,
    openBot: {
      prefix: INTEGRATIONS_API_PREFIX,
      consent: "pkce-s256",
      grantExchange: "POST /grants/exchange",
      pairFieldsAccepted: false,
    },
    ota: {
      flash: false,
      massFlash: false,
      firmwareUrl: null,
    },
  };
}

export function startDeviceControlServer(
  plane: ControlPlane,
  options: DeviceControlServerOptions = {},
): Promise<DeviceControlServer> {
  const host = options.host ?? "127.0.0.1";
  assertLabLoopbackHost(host);
  const port = options.port ?? 0;
  const env = options.env ?? process.env;
  const clients = options.serviceClients ?? clientsFromEnv(env);
  const verifier = options.grantVerifier ?? openBotGrantVerifier(env, options.fetchImpl ?? fetch);
  const server = createServer((req, res) => {
    void handleDeviceControl(plane, req, res, clients, verifier).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal", message: "internal" });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("device-control server has no port"));
        return;
      }
      resolve({
        url: originFor(host, address.port),
        port: address.port,
        close: () => closeServer(server),
      });
    });
  });
}

async function handleDeviceControl(
  plane: ControlPlane,
  req: IncomingMessage,
  res: ServerResponse,
  clients: readonly ServiceClientCredential[],
  verifier: GrantVerifier,
): Promise<void> {
  if (!peerIsLoopback(req)) {
    writeJson(res, 403, { error: "loopback", message: "device-control listens on loopback only" });
    return;
  }
  const principal = authenticate(req, clients);
  if (principal === undefined) {
    writeJson(res, 401, { error: "unauthorized", message: "service Basic is required" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  if (path === INTEGRATIONS_API_PREFIX || path.startsWith(`${INTEGRATIONS_API_PREFIX}/`)) {
    writeJson(res, 404, {
      error: "not_device_platform",
      message: "OpenBot /api/integrations/v1 is not served by device-control",
    });
    return;
  }
  try {
    if (path === `${DEVICE_CONTROL_API_PREFIX}/health`) {
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "method_not_allowed", message: "method not allowed" });
        return;
      }
      writeJson(res, 200, deviceControlHealth());
      return;
    }
    if (path === `${DEVICE_CONTROL_API_PREFIX}/capabilities`) {
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "method_not_allowed", message: "method not allowed" });
        return;
      }
      writeJson(res, 200, deviceControlCapabilities());
      return;
    }
    if (path === `${DEVICE_CONTROL_API_PREFIX}/pair-challenges`) {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method_not_allowed", message: "method not allowed" });
        return;
      }
      const body = await readJsonObject(req);
      rejectUnknown(body, ["deviceId"]);
      const deviceId = requiredString(body, "deviceId");
      writeJson(res, 201, plane.createPairChallenge(deviceId, principal));
      return;
    }
    const redeem = PAIR_REDEEM.exec(path);
    if (redeem?.[1] !== undefined) {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method_not_allowed", message: "method not allowed" });
        return;
      }
      const pairChallenge = decodePathToken(redeem[1], PAIR_CHALLENGE, "pair_challenge");
      const body = await readJsonObject(req);
      rejectUnknown(body, ["deviceId", "pairingCode"]);
      writeJson(
        res,
        200,
        plane.redeemPairChallenge({
          pairChallenge,
          deviceId: requiredString(body, "deviceId"),
          pairingCode: requiredString(body, "pairingCode"),
          servicePrincipal: principal,
        }),
      );
      return;
    }
    if (path === `${DEVICE_CONTROL_API_PREFIX}/devices`) {
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "method_not_allowed", message: "method not allowed" });
        return;
      }
      writeJson(res, 200, { devices: plane.listDevicesForPrincipal(principal) });
      return;
    }
    const sync = DEVICE_SYNC.exec(path);
    if (sync?.[1] !== undefined) {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method_not_allowed", message: "method not allowed" });
        return;
      }
      const deviceId = decodePathToken(sync[1], DEVICE_ID, "pair_device");
      const body = await readJsonObject(req);
      const grant = await verifiedGrant(req, body, deviceId, principal, verifier);
      writeJson(res, 200, plane.syncVerifiedGrant(principal, grant));
      return;
    }
    const bind = DEVICE_BIND.exec(path);
    if (bind?.[1] !== undefined) {
      if (req.method === "GET") {
        const deviceId = decodePathToken(bind[1], DEVICE_ID, "pair_device");
        writeJson(res, 200, plane.deviceForPrincipal(principal, deviceId));
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method_not_allowed", message: "method not allowed" });
        return;
      }
      const deviceId = decodePathToken(bind[1], DEVICE_ID, "pair_device");
      const body = await readJsonObject(req);
      const grant = await verifiedGrant(req, body, deviceId, principal, verifier);
      writeJson(res, 200, plane.applyVerifiedGrant(principal, grant));
      return;
    }
    const stop = DEVICE_STOP.exec(path);
    if (stop?.[1] !== undefined) {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method_not_allowed", message: "method not allowed" });
        return;
      }
      const deviceId = decodePathToken(stop[1], DEVICE_ID, "pair_device");
      const body = await readJsonObject(req);
      rejectUnknown(body, []);
      writeJson(res, 200, plane.revokeForPrincipal(principal, deviceId));
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed", message: "method not allowed" });
      return;
    }
    writeJson(res, 404, { error: "not_found", message: "unknown device-control route" });
  } catch (error) {
    writeHandlerError(res, error);
  }
}

async function verifiedGrant(
  req: IncomingMessage,
  body: Record<string, unknown>,
  deviceId: string,
  servicePrincipal: string,
  verifier: GrantVerifier,
): Promise<VerifiedGrantBinding> {
  rejectUnknown(body, ["authorizationRef", "bindingVersion", "digitalHumanId", "deviceId"], { allowDigitalHumanId: true });
  const authorizationRef = requiredString(body, "authorizationRef");
  if (body.deviceId !== undefined && body.deviceId !== deviceId) {
    throw new DeviceControlError("pair_device", "deviceId does not match the path", 400);
  }
  const presentedVersion = optionalVersion(body);
  const presentedDigitalHuman = optionalString(body, "digitalHumanId");
  const grantCredential = headerValue(req, GRANT_CREDENTIAL_HEADER);
  if (grantCredential === undefined || grantCredential.length > 512 || /[\s]/.test(grantCredential)) {
    throw new DeviceControlError("grant_credential", "X-OpenBot-Grant-Credential is required", 401);
  }
  const grant = await verifier.readGrant({ authorizationRef, grantCredential, servicePrincipal });
  if (grant.authorizationRef !== authorizationRef) {
    throw new DeviceControlError("grant_ref", "OpenBot returned a different authorizationRef", 409);
  }
  if (grant.deviceId !== deviceId) {
    throw new DeviceControlError("grant_device", "OpenBot grant is for a different device", 409);
  }
  if (presentedVersion !== undefined && presentedVersion !== grant.bindingVersion) {
    throw new DeviceControlError("grant_mismatch", "bindingVersion does not match the OpenBot grant", 409);
  }
  if (presentedDigitalHuman !== undefined && presentedDigitalHuman !== grant.digitalHumanId) {
    throw new DeviceControlError("grant_mismatch", "digitalHumanId does not match the OpenBot grant", 409);
  }
  return grant;
}

function openBotGrantVerifier(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): GrantVerifier {
  return {
    async readGrant(input: GrantReadInput): Promise<VerifiedGrantBinding> {
      if (stubLocationFromEnv(env) === undefined || serviceBasicFromEnv(env) === undefined) {
        throw new DeviceControlError(
          "grant_unverified",
          "OpenBot grant verification is not configured; device-control will not mint authorizationRef",
          503,
        );
      }
      try {
        const view = await readGrant(input.authorizationRef, { env, fetchImpl }, input.grantCredential);
        const assistant = assistantFromUnknown(view.assistant);
        const grant: VerifiedGrantBinding = {
          authorizationRef: view.authorizationRef,
          bindingVersion: view.bindingVersion,
          digitalHumanId: view.digitalHumanId,
          deviceId: view.deviceId,
          assistant,
        };
        if (view.status !== undefined) {
          grant.status = view.status;
        }
        return grant;
      } catch (error) {
        if (error instanceof DeviceControlError) {
          throw error;
        }
        throw new DeviceControlError("grant_unreachable", "OpenBot grant could not be read", 502);
      }
    },
  };
}

function assistantFromUnknown(value: unknown): AssistantFields {
  const cloned: unknown = structuredClone(value);
  assertJsonValue(cloned, "assistant");
  if (!isPlainObject(cloned)) {
    throw new DeviceControlError("grant_field", "grant assistant is not an object", 502);
  }
  return cloned;
}

function clientsFromEnv(env: NodeJS.ProcessEnv): ServiceClientCredential[] {
  const service = serviceBasicFromEnv(env);
  if (service === undefined) {
    return [];
  }
  return [{ user: service.user, password: service.password }];
}

function authenticate(req: IncomingMessage, clients: readonly ServiceClientCredential[]): string | undefined {
  const header = headerValue(req, "authorization");
  if (header === undefined || !header.startsWith("Basic ")) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const split = decoded.indexOf(":");
  if (split <= 0) {
    return undefined;
  }
  const user = decoded.slice(0, split);
  const password = decoded.slice(split + 1);
  if (!SERVICE_PRINCIPAL.test(user)) {
    return undefined;
  }
  const client = clients.find((item) => item.user === user);
  if (client === undefined) {
    return undefined;
  }
  const presented = Buffer.from(password);
  const expected = Buffer.from(client.password);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return undefined;
  }
  return user;
}

function rejectUnknown(
  body: Record<string, unknown>,
  allowed: readonly string[],
  options: { allowDigitalHumanId?: boolean } = {},
): void {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) {
      continue;
    }
    if (IDENTITY_KEYS.has(key) && !(key === "digitalHumanId" && options.allowDigitalHumanId === true)) {
      throw new DeviceControlError(
        "untrusted_identity",
        "userId, tenantId, userSubject, and unverified digitalHumanId are not accepted",
        400,
      );
    }
    if (PAIR_KEYS.has(key) || SECRET_KEYS.has(key)) {
      throw new DeviceControlError("pair_field", "pair fields and consent secrets stay off this request", 400);
    }
    throw new DeviceControlError("unknown_field", `unknown field: ${key}`, 400);
  }
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new DeviceControlError("invalid_field", `${key} is required`, 400);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (body[key] === undefined) {
    return undefined;
  }
  return requiredString(body, key);
}

function optionalVersion(body: Record<string, unknown>): number | undefined {
  if (body.bindingVersion === undefined) {
    return undefined;
  }
  const value = body.bindingVersion;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new DeviceControlError("invalid_field", "bindingVersion must be a positive integer", 400);
  }
  return value;
}

function decodePathToken(raw: string, pattern: RegExp, code: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new DeviceControlError(code, "path token is invalid", 400);
  }
  if (!pattern.test(decoded)) {
    throw new DeviceControlError(code, "path token is invalid", 400);
  }
  return decoded;
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (text.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DeviceControlError("invalid_json", "body must be a JSON object", 400);
  }
  if (!isPlainObject(parsed)) {
    throw new DeviceControlError("invalid_json", "body must be a JSON object", 400);
  }
  return parsed;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) {
        reject(new DeviceControlError("body", "body is too large", 400));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function writeHandlerError(res: ServerResponse, error: unknown): void {
  if (error instanceof DeviceControlError) {
    writeJson(res, error.status, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof FrozenFieldError) {
    writeJson(res, 400, { error: "frozen_field", message: error.message });
    return;
  }
  if (error instanceof ControlPlaneError) {
    writeJson(res, statusForPlane(error.code), { error: error.code, message: error.message });
    return;
  }
  writeJson(res, 500, { error: "internal", message: "internal" });
}

function statusForPlane(code: string): number {
  if (code === "pair_missing" || code === "bind_missing") {
    return 404;
  }
  if (code === "pair_owned" || code === "pair_code" || code === "pair_expired" || code === "bind_revoked") {
    return 403;
  }
  if (
    code === "pair_unredeemed" ||
    code === "pair_unowned" ||
    code === "grant_ref" ||
    code === "grant_stale" ||
    code === "grant_device" ||
    code === "grant_revoked" ||
    code === "grant_status"
  ) {
    return 409;
  }
  return 400;
}

function peerIsLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function originFor(host: string, port: number): string {
  const bracket = host.includes(":") ? `[${host}]` : host;
  return `http://${bracket}:${port}`;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
