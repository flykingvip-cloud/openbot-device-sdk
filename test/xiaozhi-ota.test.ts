import assert from "node:assert/strict";
import test from "node:test";

import { ControlPlane } from "../services/src/index.ts";
import { ensureLabDeviceBound } from "../services/src/claw4-lab.ts";
import {
  assertDeviceReachableVoiceUrl,
  buildXiaozhiOtaResponse,
  formatXiaozhiOtaLog,
  resolveXiaozhiVoiceWsUrl,
  startXiaozhiOtaServer,
  type XiaozhiOtaRequestLog,
} from "../services/src/xiaozhi-ota.ts";

const ASSISTANT = { voiceId: "voice-lab" };
const CLAIM_CODE = "042315";
const VOICE = "ws://192.168.1.10:8791";

function plane(): ControlPlane {
  let refs = 0;
  let tokens = 0;
  return new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => CLAIM_CODE,
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
    token: () => {
      tokens += 1;
      return `ctok_${tokens}`;
    },
  });
}

function claimAndBind(control: ControlPlane, deviceId = "80:f1:b2:d2:eb:fb"): void {
  const ticket = control.issueClaim(deviceId);
  control.redeemClaim(deviceId, ticket.code);
  control.bind({ deviceId, digitalHumanId: "dh-ota", assistant: ASSISTANT });
}

test("bound device OTA issues bare token and omits mqtt/firmware", () => {
  const control = plane();
  claimAndBind(control);
  const body = buildXiaozhiOtaResponse(control, "80:f1:b2:d2:eb:fb", VOICE, {
    now: () => 1_700_000_123_456,
    timezoneOffsetMin: 480,
  });
  assert.equal(body.server_time.timestamp, 1_700_000_123_456);
  assert.equal(body.server_time.timezone_offset, 480);
  assert.equal(body.websocket.url, VOICE);
  assert.equal(body.websocket.token, "ctok_1");
  assert.equal(body.websocket.token.startsWith("Bearer "), false);
  assert.equal(body.websocket.version, 1);
  assert.equal(body.activation, undefined);
  assert.equal(Object.hasOwn(body, "mqtt"), false);
  assert.equal(Object.hasOwn(body, "firmware"), false);
});

test("unbound device returns activation without throwing", () => {
  const control = plane();
  const body = buildXiaozhiOtaResponse(control, "80:f1:b2:d2:eb:fb", VOICE, {
    now: () => 1_700_000_000_000,
  });
  assert.equal(body.websocket.token, "");
  assert.equal(body.activation?.code, "000000");
  assert.match(body.activation?.message ?? "", /未绑定/);
  assert.equal(body.server_time.timezone_offset, 480);
  assert.equal(Object.hasOwn(body, "mqtt"), false);
  assert.equal(Object.hasOwn(body, "firmware"), false);
});

test("resolveXiaozhiVoiceWsUrl requires env or override", () => {
  assert.throws(() => resolveXiaozhiVoiceWsUrl({}), /OPENBOT_XIAOZHI_VOICE_WS_URL/);
  assert.equal(resolveXiaozhiVoiceWsUrl({}, VOICE), VOICE);
  assert.throws(() => assertDeviceReachableVoiceUrl("wss://lab.invalid/voice"), /placeholder/);
  assert.throws(() => assertDeviceReachableVoiceUrl("http://192.168.1.10/voice"), /ws:\/\//);
});

test("HTTP: missing Device-Id is 400; bound POST returns Xiaozhi JSON", async () => {
  const control = plane();
  claimAndBind(control);
  const listening = await startXiaozhiOtaServer(control, {
    host: "127.0.0.1",
    port: 0,
    voiceWsUrl: VOICE,
  });
  try {
    const missing = await fetch(`${listening.url}/xiaozhi/ota/`, { method: "POST", body: "{}" });
    assert.equal(missing.status, 400);
    const missingBody = (await missing.json()) as { error?: string };
    assert.equal(missingBody.error, "device_id");

    const ok = await fetch(`${listening.url}/xiaozhi/ota/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Device-Id": "80:f1:b2:d2:eb:fb",
        "Client-Id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ mac_address: "80:f1:b2:d2:eb:fb" }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as {
      websocket: { url: string; token: string; version: number };
      server_time: { timestamp: number; timezone_offset: number };
      mqtt?: unknown;
      firmware?: unknown;
    };
    assert.equal(body.websocket.url, VOICE);
    assert.equal(body.websocket.token, "ctok_1");
    assert.equal(body.websocket.version, 1);
    assert.equal(typeof body.server_time.timestamp, "number");
    assert.equal(body.server_time.timezone_offset, 480);
    assert.equal(body.mqtt, undefined);
    assert.equal(body.firmware, undefined);

    const health = await fetch(`${listening.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
  } finally {
    await listening.close();
  }
});

test("HTTP logs Device-Id Client-Id UA and issued token", async () => {
  const control = plane();
  claimAndBind(control);
  const logs: XiaozhiOtaRequestLog[] = [];
  const listening = await startXiaozhiOtaServer(control, {
    host: "127.0.0.1",
    port: 0,
    voiceWsUrl: VOICE,
    onRequestLog: (entry) => {
      logs.push(entry);
    },
  });
  try {
    const ok = await fetch(`${listening.url}/xiaozhi/ota/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Device-Id": "80:f1:b2:d2:eb:fb",
        "Client-Id": "11111111-1111-1111-1111-111111111111",
        "User-Agent": "claw4-test/1",
      },
      body: JSON.stringify({ mac_address: "80:f1:b2:d2:eb:fb", application: { name: "xiaozhi" } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.deviceId, "80:f1:b2:d2:eb:fb");
    assert.equal(logs[0]?.clientId, "11111111-1111-1111-1111-111111111111");
    assert.equal(logs[0]?.userAgent, "claw4-test/1");
    assert.equal(logs[0]?.tokenPresent, true);
    assert.equal(logs[0]?.unbound, false);
    assert.match(logs[0]?.bodyPreview ?? "", /mac_address/);
    const line = formatXiaozhiOtaLog(logs[0]!, new Date(2026, 10, 5, 9, 1, 2));
    assert.match(line, /deviceId=80:f1:b2:d2:eb:fb/);
    assert.match(line, /token=\(issued\)/);
  } finally {
    await listening.close();
  }
});

test("ensureLabDeviceBound creates then reuses binding", () => {
  const control = plane();
  const first = ensureLabDeviceBound(control, "80:f1:b2:d2:eb:fb");
  assert.equal(first.created, true);
  assert.match(first.authorizationRef, /^aref_/);
  const second = ensureLabDeviceBound(control, "80:f1:b2:d2:eb:fb");
  assert.equal(second.created, false);
  assert.equal(second.authorizationRef, first.authorizationRef);
  assert.equal(second.bindingVersion, first.bindingVersion);
  const body = buildXiaozhiOtaResponse(control, "80:f1:b2:d2:eb:fb", VOICE);
  assert.equal(body.websocket.token.length > 0, true);
});
