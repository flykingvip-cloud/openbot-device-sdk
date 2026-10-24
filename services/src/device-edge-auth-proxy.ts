/**
 * Lab / loopback HTTP proxy for Device → SDK edge → OpenBot two-hop auth.
 *
 * Device presents Bearer device token + X-Device-Id.
 * On verify failure: 401 and **no** upstream contact.
 * On success: forwards with Authorization Basic + grant + X-Device-Id.
 *
 * Does not mint grants. Does not change ControlPlane or device-control OpenAPI.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";

import {
  DEVICE_EDGE_DEVICE_ID_HEADER,
  DEVICE_EDGE_GRANT_HEADER,
  LabDeviceEdgeAuthProxy,
  createTokenMapDeviceVerifier,
  type DeviceEdgeServiceCredential,
} from "../../adapters/voice/src/device-edge-auth.ts";
import { assertLabLoopbackHost } from "./ota-config.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_LISTEN = { host: "127.0.0.1", port: 8792 } as const;
const PROXY_PREFIX = "/proxy";
const MAX_BODY = 256 * 1024;

export const DEVICE_EDGE_AUTH_PROXY_ENV = {
  listen: "OPENBOT_DEVICE_EDGE_LISTEN",
  upstreamUrl: "OPENBOT_DEVICE_EDGE_UPSTREAM_URL",
  serviceUser: "OPENBOT_STUB_SERVICE_USER",
  servicePassword: "OPENBOT_STUB_SERVICE_PASSWORD",
  grantCredential: "OPENBOT_STUB_GRANT_CREDENTIAL",
  /** Comma-separated deviceId:token pairs for lab smoke (not firmware). */
  labTokens: "OPENBOT_DEVICE_EDGE_LAB_TOKENS",
} as const;

export interface DeviceEdgeUpstreamHit {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBytes: number;
}

export interface DeviceEdgeAuthProxyServer {
  url: string;
  host: string;
  port: number;
  mode: "mock" | "upstream";
  close: () => Promise<void>;
  /** Lab-only: headers last seen by the embedded mock upstream (never sent to device). */
  lastUpstreamHit: () => DeviceEdgeUpstreamHit | undefined;
  proxy: LabDeviceEdgeAuthProxy;
}

export interface StartDeviceEdgeAuthProxyOptions {
  host?: string;
  port?: number;
  proxy: LabDeviceEdgeAuthProxy;
  /**
   * When set, forward to this OpenBot / stub base URL (loopback only).
   * When omitted, an embedded mock upstream records headers and returns a safe JSON body.
   */
  upstreamUrl?: string;
  fetchImpl?: typeof fetch;
}

export function parseLabTokenMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (raw === undefined || raw.trim().length === 0) {
    return map;
  }
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const split = trimmed.indexOf(":");
    if (split <= 0 || split === trimmed.length - 1) {
      throw new Error(`${DEVICE_EDGE_AUTH_PROXY_ENV.labTokens} entries must be deviceId:token`);
    }
    const deviceId = trimmed.slice(0, split);
    const token = trimmed.slice(split + 1);
    map.set(deviceId, token);
  }
  return map;
}

export function serviceCredentialFromEnv(env: NodeJS.ProcessEnv): DeviceEdgeServiceCredential | undefined {
  const user = env[DEVICE_EDGE_AUTH_PROXY_ENV.serviceUser];
  const password = env[DEVICE_EDGE_AUTH_PROXY_ENV.servicePassword];
  const grant = env[DEVICE_EDGE_AUTH_PROXY_ENV.grantCredential];
  const userSet = user !== undefined && user.length > 0;
  const passwordSet = password !== undefined && password.length > 0;
  const grantSet = grant !== undefined && grant.length > 0;
  if (!userSet && !passwordSet && !grantSet) {
    return undefined;
  }
  if (!userSet || !passwordSet || !grantSet || user === undefined || password === undefined || grant === undefined) {
    throw new Error(
      `${DEVICE_EDGE_AUTH_PROXY_ENV.serviceUser}, ${DEVICE_EDGE_AUTH_PROXY_ENV.servicePassword}, and ${DEVICE_EDGE_AUTH_PROXY_ENV.grantCredential} must be set together`,
    );
  }
  return {
    authorization: `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`,
    grantCredential: grant,
  };
}

/** Lab defaults for embedded smoke — never real platform secrets, never for firmware. */
export function labSmokeServiceCredential(): DeviceEdgeServiceCredential {
  return {
    authorization: `Basic ${Buffer.from("lab-edge-svc:lab-edge-secret", "utf8").toString("base64")}`,
    grantCredential: "lab-grant-credential",
  };
}

export function createLabDeviceEdgeAuthProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LabDeviceEdgeAuthProxy {
  const service = serviceCredentialFromEnv(env) ?? labSmokeServiceCredential();
  const tokens = parseLabTokenMap(env[DEVICE_EDGE_AUTH_PROXY_ENV.labTokens]);
  if (tokens.size === 0) {
    tokens.set("dev-edge-lab", "ctok_edge_lab");
  }
  return new LabDeviceEdgeAuthProxy({
    service,
    verifyDevice: createTokenMapDeviceVerifier(tokens),
  });
}

export function assertLoopbackUpstreamUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("upstream URL must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("upstream URL must be http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("upstream URL must not embed credentials");
  }
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("upstream URL must be loopback (127.0.0.1, localhost, or ::1)");
  }
  return url;
}

export async function startDeviceEdgeAuthProxyServer(
  options: StartDeviceEdgeAuthProxyOptions,
): Promise<DeviceEdgeAuthProxyServer> {
  const host = options.host ?? DEFAULT_LISTEN.host;
  const port = options.port ?? DEFAULT_LISTEN.port;
  assertLabLoopbackHost(host);

  const upstreamBase =
    options.upstreamUrl !== undefined && options.upstreamUrl.length > 0
      ? assertLoopbackUpstreamUrl(options.upstreamUrl)
      : undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastHit: DeviceEdgeUpstreamHit | undefined;

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      proxy: options.proxy,
      origin: `http://${host}:${port}`,
      upstreamBase,
      fetchImpl,
      onMockHit: (hit) => {
        lastHit = hit;
      },
    }).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal" });
      }
    });
  });

  await listen(server, host, port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("device-edge-auth proxy failed to bind");
  }

  return {
    url: `http://${host}:${address.port}`,
    host,
    port: address.port,
    mode: upstreamBase === undefined ? "mock" : "upstream",
    proxy: options.proxy,
    lastUpstreamHit: () => lastHit,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

interface HandleContext {
  proxy: LabDeviceEdgeAuthProxy;
  origin: string;
  upstreamBase: URL | undefined;
  fetchImpl: typeof fetch;
  onMockHit: (hit: DeviceEdgeUpstreamHit) => void;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandleContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", ctx.origin);
  if (url.pathname === "/healthz") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    writeJson(res, 200, {
      ok: true,
      service: "device-edge-auth-proxy",
      mode: ctx.upstreamBase === undefined ? "mock" : "upstream",
      firmwareUrl: null,
    });
    return;
  }

  if (!url.pathname.startsWith(`${PROXY_PREFIX}/`) && url.pathname !== PROXY_PREFIX) {
    writeJson(res, 404, { error: "not_found" });
    return;
  }

  if (!peerIsLoopback(req)) {
    writeJson(res, 403, { error: "loopback" });
    return;
  }

  const deviceId = headerValue(req, DEVICE_EDGE_DEVICE_ID_HEADER.toLowerCase());
  const deviceToken = bearer(headerValue(req, "authorization"));
  if (deviceId === undefined || deviceToken === undefined) {
    writeJson(res, 401, { error: "device_unauthorized" });
    return;
  }

  const authorized = await ctx.proxy.authorize({ deviceId, deviceToken });
  if (!authorized.ok) {
    // Hard rule: failed device hop never contacts OpenBot / upstream.
    writeJson(res, 401, { error: authorized.error });
    return;
  }

  const forwardPath =
    url.pathname === PROXY_PREFIX
      ? "/"
      : url.pathname.slice(PROXY_PREFIX.length) + url.search;
  const body = await readBody(req);

  if (ctx.upstreamBase === undefined) {
    const hit: DeviceEdgeUpstreamHit = {
      method: req.method ?? "GET",
      path: forwardPath,
      headers: { ...authorized.headers },
      bodyBytes: body.length,
    };
    ctx.onMockHit(hit);
    // Safe device-facing body: presence flags only — never echo service Basic.
    writeJson(res, 200, {
      ok: true,
      mode: "mock",
      upstream: {
        method: hit.method,
        path: hit.path,
        receivedAuthorization: Boolean(hit.headers.Authorization?.startsWith("Basic ")),
        receivedGrant: Boolean(hit.headers[DEVICE_EDGE_GRANT_HEADER]),
        receivedDeviceId: hit.headers[DEVICE_EDGE_DEVICE_ID_HEADER] === deviceId,
        deviceId,
      },
    });
    return;
  }

  const target = new URL(forwardPath, ctx.upstreamBase);
  const upstreamHeaders = new Headers();
  for (const [name, value] of Object.entries(authorized.headers)) {
    upstreamHeaders.set(name, value);
  }
  const contentType = headerValue(req, "content-type");
  if (contentType !== undefined) {
    upstreamHeaders.set("content-type", contentType);
  }

  const method = req.method ?? "GET";
  const init: RequestInit = {
    method,
    headers: upstreamHeaders,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = new Uint8Array(body);
  }
  const upstream = await ctx.fetchImpl(target, init);

  const responseBody = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "content-length": String(responseBody.length),
  });
  res.end(responseBody);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

export { PROXY_PREFIX as DEVICE_EDGE_PROXY_PREFIX };
