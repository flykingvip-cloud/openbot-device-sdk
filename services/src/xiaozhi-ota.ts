import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ControlPlane } from "./control-plane.ts";
import { ControlPlaneError } from "./errors.ts";

/** Env: device-reachable voice ws/wss URL put into Xiaozhi OTA responses. */
export const XIAOZHI_VOICE_WS_ENV = "OPENBOT_XIAOZHI_VOICE_WS_URL";

/** Optional override for server_time.timezone_offset (minutes). Default 480 (UTC+8). */
export const XIAOZHI_TZ_OFFSET_ENV = "OPENBOT_XIAOZHI_TIMEZONE_OFFSET_MIN";

const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const OTA_PATHS = new Set(["/xiaozhi/ota", "/xiaozhi/ota/"]);

export interface XiaozhiServerTime {
  timestamp: number;
  timezone_offset: number;
}

export interface XiaozhiWebsocketConfig {
  url: string;
  token: string;
  version: number;
}

export interface XiaozhiActivation {
  code: string;
  message: string;
  timeout_ms: number;
}

/**
 * Xiaozhi / Metalio OTA check-version body.
 * Never include `mqtt` (firmware prefers MQTT over websocket) or `firmware` during bring-up.
 */
export interface XiaozhiOtaResponse {
  server_time: XiaozhiServerTime;
  websocket: XiaozhiWebsocketConfig;
  activation?: XiaozhiActivation;
}

export interface XiaozhiOtaServerOptions {
  host: string;
  port: number;
  /** Device-reachable voice URL. Required; must not be loopback-derived from 0.0.0.0 listen. */
  voiceWsUrl: string;
  env?: NodeJS.ProcessEnv;
  timezoneOffsetMin?: number;
}

export interface XiaozhiOtaServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function resolveXiaozhiVoiceWsUrl(env: NodeJS.ProcessEnv, override?: string): string {
  const raw = override ?? env[XIAOZHI_VOICE_WS_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(`${XIAOZHI_VOICE_WS_ENV} (or --voice-ws) is required: device-reachable ws:// or wss:// URL`);
  }
  return assertDeviceReachableVoiceUrl(raw.trim());
}

export function assertDeviceReachableVoiceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid voice URL: ${value}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`voice URL must be ws:// or wss://, got ${value}`);
  }
  const host = url.hostname.toLowerCase();
  if (host === "lab.invalid") {
    throw new Error(`refusing placeholder voice URL ${value}`);
  }
  if (/tenclass/i.test(value)) {
    throw new Error(`refusing tenclass voice URL ${value}`);
  }
  return value;
}

export function buildXiaozhiOtaResponse(
  plane: ControlPlane,
  deviceId: string,
  voiceWsUrl: string,
  options: { now?: () => number; timezoneOffsetMin?: number } = {},
): XiaozhiOtaResponse {
  const now = options.now ?? Date.now;
  const timezone_offset = options.timezoneOffsetMin ?? 480;
  const server_time: XiaozhiServerTime = {
    timestamp: now(),
    timezone_offset,
  };

  try {
    const credential = plane.issueConnectionCredential(deviceId);
    return {
      server_time,
      websocket: {
        url: voiceWsUrl,
        token: credential.token,
        version: 1,
      },
    };
  } catch (error) {
    if (!(error instanceof ControlPlaneError)) {
      throw error;
    }
    // Unbound / revoked: keep 200 so the device can show activation, never omit server_time.
    const message =
      error.code === "credential_revoked"
        ? "设备已吊销，请在 OpenBot 控制台重新绑定"
        : "设备未绑定，请先在 OpenBot 控制台完成绑定";
    return {
      server_time,
      websocket: {
        url: voiceWsUrl,
        token: "",
        version: 1,
      },
      activation: {
        code: "000000",
        message,
        timeout_ms: 60_000,
      },
    };
  }
}

export function startXiaozhiOtaServer(
  plane: ControlPlane,
  options: XiaozhiOtaServerOptions,
): Promise<XiaozhiOtaServer> {
  const voiceWsUrl = assertDeviceReachableVoiceUrl(options.voiceWsUrl);
  const env = options.env ?? process.env;
  const timezoneOffsetMin =
    options.timezoneOffsetMin ??
    (env[XIAOZHI_TZ_OFFSET_ENV] !== undefined && env[XIAOZHI_TZ_OFFSET_ENV].length > 0
      ? Number(env[XIAOZHI_TZ_OFFSET_ENV])
      : 480);
  if (!Number.isFinite(timezoneOffsetMin)) {
    throw new Error(`${XIAOZHI_TZ_OFFSET_ENV} must be a number of minutes`);
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleXiaozhiOtaRequest(plane, req, res, {
        voiceWsUrl,
        timezoneOffsetMin,
      }).catch(() => {
        if (!res.headersSent) {
          writeJson(res, 500, { error: "internal" });
        }
      });
    });
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("xiaozhi ota listen address unavailable"));
        return;
      }
      const advertisedHost =
        options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
      resolve({
        url: `http://${advertisedHost}:${address.port}`,
        port: address.port,
        close: () => closeServer(server),
      });
    });
  });
}

export async function handleXiaozhiOtaRequest(
  plane: ControlPlane,
  req: IncomingMessage,
  res: ServerResponse,
  options: { voiceWsUrl: string; timezoneOffsetMin?: number; now?: () => number },
): Promise<void> {
  const host = req.headers.host ?? "127.0.0.1";
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
  } catch {
    writeJson(res, 400, { error: "bad_request" });
    return;
  }

  if (pathname === "/healthz") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  if (!OTA_PATHS.has(pathname)) {
    await drainBody(req);
    writeJson(res, 404, { error: "not_found" });
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  await drainBody(req);

  const deviceId = headerValue(req, "device-id");
  if (deviceId === undefined || !DEVICE_ID.test(deviceId)) {
    writeJson(res, 400, { error: "device_id" });
    return;
  }

  const body = buildXiaozhiOtaResponse(plane, deviceId, options.voiceWsUrl, {
    now: options.now,
    timezoneOffsetMin: options.timezoneOffsetMin ?? 480,
  });

  // Hard guard: never emit mqtt or firmware keys.
  const payload = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  delete payload.mqtt;
  delete payload.firmware;
  writeJson(res, 200, payload);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function drainBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on("data", () => {});
    req.on("end", () => resolve());
    req.on("error", reject);
  });
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
