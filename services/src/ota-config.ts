import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  LIVE_STUB_ENV,
  OPENBOT_CONTRACT_SHA,
  agentSessionForceEnabled,
  gatewayAgentIdFromEnv,
  stubLocationFromEnv,
} from "../../contracts/src/index.ts";
import { ControlPlane, type ConnectionCredential } from "./control-plane.ts";
import { ControlPlaneError } from "./errors.ts";

/** Placeholder used until a lab voice server is advertised. Not api.tenclass.net. */
export const LAB_VOICE_WSS_URL = "wss://lab.invalid/voice";

/** When set to a loopback ws:// or wss:// URL, claimed config uses that lab voice server. */
export const LAB_VOICE_WSS_ENV = "OPENBOT_LAB_VOICE_WSS_URL";

/** Header carrying the redeemed claim code. A device id in the path is not proof. */
export const LAB_DEVICE_PROOF_HEADER = "x-openbot-device-proof";

/**
 * Routes this lab OTA process actually serves.
 * Grants, conversations, and runs are not in this list.
 */
export const LAB_DEVICE_PLATFORM_ENDPOINTS = [
  "GET /healthz",
  "GET /devices/{deviceId}/config",
  "POST /devices/{deviceId}/credentials",
  "GET /devices/{deviceId}/credentials",
  "POST /devices/{deviceId}/credentials/refresh",
] as const;

const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEVICE_CONFIG = /^\/devices\/([^/]+)\/config$/;
const DEVICE_CREDENTIALS = /^\/devices\/([^/]+)\/credentials$/;
const DEVICE_REFRESH = /^\/devices\/([^/]+)\/credentials\/refresh$/;

export type LabPairingNext = "issue-claim" | "redeem-claim" | "bind" | "present-claim-code" | "revoked";

/**
 * Unauthenticated device config. URLs and pairing hints only.
 * No token and no auth profile (`authorizationRef`, `bindingVersion`, `digitalHumanId`).
 */
export interface LabDeviceConfig {
  contractSha: typeof OPENBOT_CONTRACT_SHA;
  /**
   * Static match between vendored OpenAPI paths and the consumer mirror.
   * This is not an end-to-end OpenBot pass.
   */
  routesAligned: true;
  deviceId: string;
  claimStatus: "missing" | "pending" | "claimed";
  revoked: boolean;
  pairing: { next: LabPairingNext };
  voiceWssUrl: string;
  /** Origin of this lab process. Not the OpenBot integrations prefix. */
  devicePlatformUrl: string;
  devicePlatformEndpoints: typeof LAB_DEVICE_PLATFORM_ENDPOINTS;
  /** Separate OpenBot connector. Null until a loopback stub URL is configured. */
  openBotConnectorUrl: string | null;
  firmwareUrl: null;
  executable: false;
  force: 0;
}

/** Returned only after device identity is verified. */
export interface LabDeviceCredential {
  deviceId: string;
  token: string;
  tokenExpiresAtMs: number;
  authorizationRef: string;
  bindingVersion: number;
  digitalHumanId: string;
  gatewayAgentId: string | null;
  agentSessionForce: boolean;
}

export function assertLabLoopbackHost(host: string): void {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!LOOPBACK_HOSTS.has(bare.toLowerCase())) {
    throw new Error("lab ota config refuses non-loopback hosts until device auth exists");
  }
}

/**
 * Lab config for one device. This never mints or returns a connection token.
 * `firmwareUrl` stays null. This does not call `flash` or `massFlash`.
 */
export function resolveLabVoiceWssUrl(env: NodeJS.ProcessEnv, override?: string): string {
  const raw = override ?? env[LAB_VOICE_WSS_ENV];
  if (raw === undefined || raw.length === 0 || !isLabVoiceUrl(raw)) {
    return LAB_VOICE_WSS_URL;
  }
  return raw;
}

function isLabVoiceUrl(value: string): boolean {
  if (/tenclass/i.test(value)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return false;
  }
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "lab.invalid";
}

export function buildLabDeviceConfig(
  plane: ControlPlane,
  deviceId: string,
  origin: string,
  options: { env?: NodeJS.ProcessEnv; voiceWssUrl?: string } = {},
): LabDeviceConfig {
  if (!DEVICE_ID.test(deviceId)) {
    throw new Error("deviceId is required");
  }
  const env = options.env ?? process.env;
  const claimStatus = plane.claimStatus(deviceId);
  const binding = plane.getBinding(deviceId);
  const revoked = plane.isRevoked(deviceId);
  return {
    contractSha: OPENBOT_CONTRACT_SHA,
    routesAligned: true,
    deviceId,
    claimStatus,
    revoked,
    pairing: { next: pairingNext(claimStatus, revoked, binding !== undefined) },
    voiceWssUrl: resolveLabVoiceWssUrl(env, options.voiceWssUrl),
    devicePlatformUrl: origin.replace(/\/$/, ""),
    devicePlatformEndpoints: LAB_DEVICE_PLATFORM_ENDPOINTS,
    openBotConnectorUrl: openBotConnectorUrl(env),
    firmwareUrl: null,
    executable: false,
    force: 0,
  };
}

export function issueLabDeviceCredential(
  plane: ControlPlane,
  deviceId: string,
  claimCode: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): LabDeviceCredential {
  const credential = plane.issueConnectionCredentialWithProof(deviceId, claimCode);
  return credentialView(plane, deviceId, credential, options.env ?? process.env);
}

export function readLabDeviceCredential(
  plane: ControlPlane,
  deviceId: string,
  token: string | undefined,
  options: { env?: NodeJS.ProcessEnv } = {},
): LabDeviceCredential {
  const decision = plane.assessConnectionCredential(deviceId, token);
  if (!decision.ok) {
    throw new ControlPlaneError(decision.code, "connection credential was not accepted");
  }
  return credentialView(plane, deviceId, decision.credential, options.env ?? process.env);
}

export function refreshLabDeviceCredential(
  plane: ControlPlane,
  deviceId: string,
  token: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): LabDeviceCredential {
  const credential = plane.refreshConnectionCredential(deviceId, token);
  return credentialView(plane, deviceId, credential, options.env ?? process.env);
}

function credentialView(
  plane: ControlPlane,
  deviceId: string,
  credential: ConnectionCredential,
  env: NodeJS.ProcessEnv,
): LabDeviceCredential {
  const binding = plane.getBinding(deviceId);
  if (!binding) {
    throw new ControlPlaneError("bind_missing", "device is not bound");
  }
  return {
    deviceId,
    token: credential.token,
    tokenExpiresAtMs: credential.expiresAtMs,
    authorizationRef: credential.authorizationRef,
    bindingVersion: credential.bindingVersion,
    digitalHumanId: binding.digitalHumanId,
    gatewayAgentId: gatewayAgentIdFromEnv(env),
    agentSessionForce: agentSessionForceEnabled(env),
  };
}

function pairingNext(
  claimStatus: "missing" | "pending" | "claimed",
  revoked: boolean,
  bound: boolean,
): LabPairingNext {
  if (revoked) {
    return "revoked";
  }
  if (claimStatus === "missing") {
    return "issue-claim";
  }
  if (claimStatus === "pending") {
    return "redeem-claim";
  }
  if (!bound) {
    return "bind";
  }
  return "present-claim-code";
}

function openBotConnectorUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env[LIVE_STUB_ENV];
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  return stubLocationFromEnv(env)?.integrationsBase ?? null;
}

export interface LabOtaConfigServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function startLabOtaConfigServer(
  plane: ControlPlane,
  options: { host?: string; port?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<LabOtaConfigServer> {
  const host = options.host ?? "127.0.0.1";
  assertLabLoopbackHost(host);
  const port = options.port ?? 0;
  const env = options.env ?? process.env;
  const server = createServer((req, res) => {
    const address = server.address();
    const boundPort = address !== null && typeof address === "object" ? address.port : port;
    void handleLabOtaConfig(plane, req, res, originFor(host, boundPort), env).catch(() => {
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
        reject(new Error("lab ota config server has no port"));
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

export async function handleLabOtaConfig(
  plane: ControlPlane,
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const url = new URL(req.url ?? "/", origin);
  if (url.pathname === "/healthz") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    writeJson(res, 200, { ok: true, service: "lab-ota-config", firmwareUrl: null, executable: false });
    return;
  }
  const configMatch = DEVICE_CONFIG.exec(url.pathname);
  if (configMatch?.[1] !== undefined) {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const deviceId = decodeDeviceId(configMatch[1], res);
    if (deviceId === undefined) {
      return;
    }
    writeJson(res, 200, buildLabDeviceConfig(plane, deviceId, origin, { env }));
    return;
  }
  const refreshMatch = DEVICE_REFRESH.exec(url.pathname);
  if (refreshMatch?.[1] !== undefined) {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await readBody(req);
    if (!peerIsLoopback(req)) {
      writeJson(res, 403, { error: "loopback" });
      return;
    }
    const deviceId = decodeDeviceId(refreshMatch[1], res);
    if (deviceId === undefined) {
      return;
    }
    const token = bearer(headerValue(req, "authorization"));
    if (token === undefined) {
      writeJson(res, 401, { error: "device_proof" });
      return;
    }
    try {
      writeJson(res, 200, refreshLabDeviceCredential(plane, deviceId, token, { env }));
    } catch (error) {
      writePlaneError(res, error);
    }
    return;
  }
  const credentialMatch = DEVICE_CREDENTIALS.exec(url.pathname);
  if (credentialMatch?.[1] !== undefined) {
    if (req.method !== "GET" && req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : "";
    if (!peerIsLoopback(req)) {
      writeJson(res, 403, { error: "loopback" });
      return;
    }
    const deviceId = decodeDeviceId(credentialMatch[1], res);
    if (deviceId === undefined) {
      return;
    }
    try {
      if (req.method === "GET") {
        writeJson(res, 200, readLabDeviceCredential(plane, deviceId, bearer(headerValue(req, "authorization")), { env }));
        return;
      }
      const claimCode = deviceProof(req, body);
      if (claimCode === undefined) {
        writeJson(res, 401, { error: "device_proof" });
        return;
      }
      writeJson(res, 200, issueLabDeviceCredential(plane, deviceId, claimCode, { env }));
    } catch (error) {
      writePlaneError(res, error);
    }
    return;
  }
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  writeJson(res, 404, { error: "not_found" });
}

function decodeDeviceId(raw: string, res: ServerResponse): string | undefined {
  let deviceId: string;
  try {
    deviceId = decodeURIComponent(raw);
  } catch {
    writeJson(res, 400, { error: "device_id" });
    return undefined;
  }
  if (!DEVICE_ID.test(deviceId)) {
    writeJson(res, 400, { error: "device_id" });
    return undefined;
  }
  return deviceId;
}

function deviceProof(req: IncomingMessage, body: string): string | undefined {
  const header = headerValue(req, LAB_DEVICE_PROOF_HEADER);
  if (header !== undefined) {
    return header;
  }
  if (body.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("claimCode" in parsed)) {
      return undefined;
    }
    const claimCode = (parsed as { claimCode?: unknown }).claimCode;
    return typeof claimCode === "string" && claimCode.length > 0 ? claimCode : undefined;
  } catch {
    return undefined;
  }
}

function peerIsLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bearer(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

function writePlaneError(res: ServerResponse, error: unknown): void {
  if (error instanceof ControlPlaneError) {
    const status = error.code === "credential_revoked" || error.code === "loopback" ? 403 : 401;
    writeJson(res, status, { error: error.code });
    return;
  }
  writeJson(res, 500, { error: "internal" });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error("body"));
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

function originFor(host: string, port: number): string {
  const bracket = host.includes(":") ? `[${host}]` : host;
  return `http://${bracket}:${port}`;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
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
