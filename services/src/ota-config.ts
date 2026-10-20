import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { INTEGRATIONS_API_PREFIX, OPENBOT_CONTRACT_SHA } from "../../contracts/src/index.ts";
import { ControlPlane } from "./control-plane.ts";

/** Placeholder used until a lab voice server is advertised. Not api.tenclass.net. */
export const LAB_VOICE_WSS_URL = "wss://lab.invalid/voice";

/** When set to a loopback ws:// or wss:// URL, claimed config uses that lab voice server. */
export const LAB_VOICE_WSS_ENV = "OPENBOT_LAB_VOICE_WSS_URL";

const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface LabDeviceConfig {
  contractSha: typeof OPENBOT_CONTRACT_SHA;
  routesAligned: true;
  deviceId: string;
  claimStatus: "missing" | "pending" | "claimed";
  revoked: boolean;
  voiceWssUrl: string;
  deviceApiUrl: string;
  apiPrefix: typeof INTEGRATIONS_API_PREFIX;
  bindingVersion: number | null;
  authorizationRef: string | null;
  digitalHumanId: string | null;
  token: string | null;
  tokenExpiresAtMs: number | null;
  firmwareUrl: null;
  executable: false;
  force: 0;
}

/**
 * Lab config for one device. A token is minted only after claim and bind,
 * and only while the device is not revoked. `firmwareUrl` stays null.
 * This does not call `flash` or `massFlash`.
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
  const claimStatus = plane.claimStatus(deviceId);
  const binding = plane.getBinding(deviceId);
  const revoked = plane.isRevoked(deviceId);
  let token: string | null = null;
  let tokenExpiresAtMs: number | null = null;
  if (binding && !revoked) {
    const credential = plane.activeConnectionCredential(deviceId) ?? plane.issueConnectionCredential(deviceId);
    token = credential.token;
    tokenExpiresAtMs = credential.expiresAtMs;
  }
  return {
    contractSha: OPENBOT_CONTRACT_SHA,
    routesAligned: true,
    deviceId,
    claimStatus,
    revoked,
    voiceWssUrl: resolveLabVoiceWssUrl(options.env ?? process.env, options.voiceWssUrl),
    deviceApiUrl: `${origin.replace(/\/$/, "")}${INTEGRATIONS_API_PREFIX}`,
    apiPrefix: INTEGRATIONS_API_PREFIX,
    bindingVersion: binding?.bindingVersion ?? null,
    authorizationRef: binding?.authorizationRef ?? null,
    digitalHumanId: binding?.digitalHumanId ?? null,
    token,
    tokenExpiresAtMs,
    firmwareUrl: null,
    executable: false,
    force: 0,
  };
}

export interface LabOtaConfigServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function startLabOtaConfigServer(
  plane: ControlPlane,
  options: { host?: string; port?: number } = {},
): Promise<LabOtaConfigServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const server = createServer((req, res) => {
    const advertisedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const address = server.address();
    const boundPort = address !== null && typeof address === "object" ? address.port : port;
    handleLabOtaConfig(plane, req, res, `http://${advertisedHost}:${boundPort}`);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("lab ota config server has no port"));
        return;
      }
      const advertisedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      resolve({
        url: `http://${advertisedHost}:${address.port}`,
        port: address.port,
        close: () => closeServer(server),
      });
    });
  });
}

export function handleLabOtaConfig(
  plane: ControlPlane,
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
): void {
  const url = new URL(req.url ?? "/", origin);
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (url.pathname === "/healthz") {
    writeJson(res, 200, { ok: true, service: "lab-ota-config", firmwareUrl: null, executable: false });
    return;
  }
  const match = /^\/devices\/([^/]+)\/config$/.exec(url.pathname);
  if (!match || match[1] === undefined) {
    writeJson(res, 404, { error: "not_found" });
    return;
  }
  let deviceId: string;
  try {
    deviceId = decodeURIComponent(match[1]);
  } catch {
    writeJson(res, 400, { error: "device_id" });
    return;
  }
  if (!DEVICE_ID.test(deviceId)) {
    writeJson(res, 400, { error: "device_id" });
    return;
  }
  writeJson(res, 200, buildLabDeviceConfig(plane, deviceId, origin));
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
