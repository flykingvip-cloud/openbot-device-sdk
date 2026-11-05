#!/usr/bin/env node
/**
 * Lab Xiaozhi OTA → OpenBot voice WSS bridge (deployment-side only).
 *
 * Standalone. Does NOT change frozen device-control OpenAPI, CONTRACT SHA,
 * or core SDK services API shapes. Does NOT mint authorizationRef / grants.
 * Does NOT proxy /api/integrations/v1. Never returns firmware / firmware.url.
 *
 * Metalio NVS wifi/ota_url → http://<bridge-host>:8002/xiaozhi/ota/
 */

import http from "node:http";
import { URL } from "node:url";

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8002);
const OTA_CONFIG_URL = (
  process.env.OPENBOT_OTA_CONFIG_URL || "http://127.0.0.1:8790"
).replace(/\/$/, "");
const DEVICE_ID = process.env.OPENBOT_DEVICE_ID || "";
const DEVICE_TOKEN = process.env.OPENBOT_DEVICE_TOKEN || "";
/** Lab override only when ota-config is unreachable. Documented in README. */
const VOICE_WSS_FALLBACK = process.env.OPENBOT_VOICE_WSS_URL || "";
/** Device-facing advertise URL (e.g. LAN ws://192.168.x.x:8792/). Always wins when set. */
const VOICE_WSS_ADVERTISE = process.env.OPENBOT_VOICE_WSS_ADVERTISE_URL || "";
const CACHE_TTL_MS = 30_000;
const LAB_INVALID = "wss://lab.invalid/voice";
const TIMEZONE_OFFSET_MIN = 480; // Asia/Shanghai UTC+8

/** @type {{ url: string, fetchedAt: number } | null} */
let voiceUrlCache = null;

function drain(req) {
  return new Promise((resolve, reject) => {
    req.on("data", () => {});
    req.on("end", resolve);
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function writeText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function assertToken(token) {
  if (!token || typeof token !== "string" || token.length === 0) {
    throw new Error(
      "OPENBOT_DEVICE_TOKEN is empty; set a non-empty token for real smoke (claim/bind first)",
    );
  }
  if (/\s/.test(token)) {
    throw new Error("OPENBOT_DEVICE_TOKEN must not contain whitespace");
  }
  return token;
}

function assertVoiceUrl(url) {
  if (!url || typeof url !== "string") {
    throw new Error("voice WSS URL missing");
  }
  if (url === LAB_INVALID || url.startsWith("wss://lab.invalid")) {
    throw new Error(
      `refusing placeholder voice URL ${url}; set OPENBOT_LAB_VOICE_WSS_URL on ota-config, or lab override OPENBOT_VOICE_WSS_URL on this bridge`,
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid voice WSS URL: ${url}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`voice URL must be ws:// or wss://, got ${url}`);
  }
  return url;
}

async function fetchVoiceWssFromOtaConfig(deviceId) {
  const id = deviceId || DEVICE_ID;
  if (!id) {
    throw new Error(
      "OPENBOT_DEVICE_ID (or Device-Id header) required to resolve voiceWssUrl from ota-config",
    );
  }
  const url = `${OTA_CONFIG_URL}/devices/${encodeURIComponent(id)}/config`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2500);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw new Error(`ota-config HTTP ${res.status} for ${url}`);
    }
    const body = await res.json();
    if (!body || typeof body.voiceWssUrl !== "string") {
      throw new Error("ota-config response missing voiceWssUrl");
    }
    return assertVoiceUrl(body.voiceWssUrl);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveVoiceWssUrl(deviceId) {
  const now = Date.now();
  if (VOICE_WSS_ADVERTISE) {
    // Prefer explicit device-reachable URL; ota-config may only hold loopback.
    const advertised = assertVoiceUrl(VOICE_WSS_ADVERTISE);
    try {
      await fetchVoiceWssFromOtaConfig(deviceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ota-bridge] ota-config check failed while advertising (${msg})`);
    }
    voiceUrlCache = { url: advertised, fetchedAt: now };
    return advertised;
  }
  if (voiceUrlCache && now - voiceUrlCache.fetchedAt < CACHE_TTL_MS) {
    return voiceUrlCache.url;
  }
  try {
    const url = await fetchVoiceWssFromOtaConfig(deviceId);
    voiceUrlCache = { url, fetchedAt: now };
    return url;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (VOICE_WSS_FALLBACK) {
      console.warn(
        `[ota-bridge] ota-config unreachable (${msg}); using lab override OPENBOT_VOICE_WSS_URL`,
      );
      const url = assertVoiceUrl(VOICE_WSS_FALLBACK);
      voiceUrlCache = { url, fetchedAt: now };
      return url;
    }
    throw err;
  }
}

function isOtaPath(pathname) {
  return pathname === "/xiaozhi/ota" || pathname === "/xiaozhi/ota/";
}

async function handleOta(req, res, pathname) {
  await drain(req);
  const deviceIdHeader =
    req.headers["device-id"] || req.headers["Device-Id"] || "";
  const deviceId =
    (typeof deviceIdHeader === "string" ? deviceIdHeader : deviceIdHeader[0]) ||
    DEVICE_ID ||
    "";
  console.log(
    `[ota-bridge] ${req.method} ${pathname} Device-Id=${deviceId || "(none)"}`,
  );

  let token;
  try {
    token = assertToken(DEVICE_TOKEN);
  } catch (err) {
    writeJson(res, 503, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let voiceUrl;
  try {
    voiceUrl = await resolveVoiceWssUrl(deviceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ota-bridge] resolve voice URL failed: ${message}`);
    writeJson(res, 503, { error: message });
    return;
  }

  // Xiaozhi/Metalio OTA check-version shape. No firmware section — ever.
  const body = {
    websocket: {
      url: voiceUrl,
      token,
      version: 1,
    },
    server_time: {
      timestamp: Date.now(),
      timezone_offset: TIMEZONE_OFFSET_MIN,
    },
  };
  writeJson(res, 200, body);
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `127.0.0.1:${BRIDGE_PORT}`;
  let pathname = "/";
  try {
    pathname = new URL(req.url || "/", `http://${host}`).pathname;
  } catch {
    writeText(res, 400, "bad request");
    return;
  }

  try {
    if (pathname === "/healthz") {
      writeText(res, 200, "ok");
      return;
    }
    if (isOtaPath(pathname) && (req.method === "GET" || req.method === "POST")) {
      await handleOta(req, res, pathname);
      return;
    }
    await drain(req);
    writeText(res, 404, "not found");
  } catch (err) {
    console.error("[ota-bridge] handler error", err);
    if (!res.headersSent) {
      writeText(res, 500, "internal error");
    }
  }
});

server.listen(BRIDGE_PORT, "0.0.0.0", () => {
  console.log(
    `[ota-bridge] listening 0.0.0.0:${BRIDGE_PORT}  ota-config=${OTA_CONFIG_URL}  device=${DEVICE_ID || "(from Device-Id)"}`,
  );
  console.log(
    `[ota-bridge] endpoints: GET|POST /xiaozhi/ota/  GET|POST /xiaozhi/ota  GET /healthz`,
  );
  if (!DEVICE_TOKEN) {
    console.warn(
      "[ota-bridge] WARNING: OPENBOT_DEVICE_TOKEN empty — OTA responses will 503 until set",
    );
  }
  if (VOICE_WSS_FALLBACK) {
    console.warn(
      "[ota-bridge] OPENBOT_VOICE_WSS_URL lab override present (used only if ota-config unreachable)",
    );
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
