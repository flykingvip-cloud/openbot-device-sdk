import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ControlPlane } from "../services/src/index.ts";
import {
  DeviceControl,
  DeviceControlError,
  PAIR_ATTEMPT_LIMIT,
  rejectBrowserIdentity,
  startDeviceControlServer,
} from "../services/src/device-control.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../services/src/device-control-cli.ts", import.meta.url));

const SERVICE = { clientId: "svc-ui", secret: "service-secret-16" };
const OTHER = { clientId: "svc-other", secret: "other-service-16x" };
const AUTH = `restricted-auth-16`;

function control(now = () => 1_700_000_000_000, plane?: ControlPlane): DeviceControl {
  return new DeviceControl({
    clients: [SERVICE, OTHER],
    now,
    ...(plane === undefined ? {} : { plane }),
    secret: () => "pair-secret-once-16",
  });
}

function pair(api: DeviceControl, subject = SERVICE.clientId, deviceId = "dev-1"): void {
  const created = api.createPairChallenge(subject, deviceId);
  assert.equal(created.secret, "pair-secret-once-16");
  assert.equal(created.initiator, subject);
  api.verifyPairChallenge(subject, created.challengeId, deviceId, "pair-secret-once-16");
}

test("service basic is the subject, and browser identity fields are rejected", () => {
  const api = control();
  assert.equal(api.authenticate(`Basic ${Buffer.from("svc-ui:service-secret-16").toString("base64")}`), "svc-ui");
  assert.throws(() => api.authenticate(undefined), (error: unknown) => error instanceof DeviceControlError && error.status === 401);
  assert.throws(
    () => new DeviceControl({ clients: [{ clientId: "short", secret: "too-short" }] }),
    (error: unknown) => error instanceof DeviceControlError && error.code === "service_client",
  );
  assert.throws(
    () => rejectBrowserIdentity({ digitalHumanId: "dh-browser", tenantId: "tenant-browser" }),
    (error: unknown) => error instanceof DeviceControlError && error.code === "browser_identity",
  );
  const created = api.createPairChallenge(SERVICE.clientId, "dev-1");
  assert.equal("userSubject" in created, false);
  assert.throws(
    () => api.verifyPairChallenge(OTHER.clientId, created.challengeId, "dev-1", "pair-secret-once-16"),
    (error: unknown) => error instanceof DeviceControlError && error.status === 404,
  );
});

test("pair challenge is one-shot, attempt-limited, and bound to initiator plus device", () => {
  let now = 1_700_000_000_000;
  const api = control(() => now);
  const created = api.createPairChallenge(SERVICE.clientId, "dev-1");
  assert.throws(
    () => api.verifyPairChallenge(SERVICE.clientId, created.challengeId, "dev-other", "pair-secret-once-16"),
    (error: unknown) => error instanceof DeviceControlError && error.code === "challenge_device",
  );
  for (let attempt = 0; attempt < PAIR_ATTEMPT_LIMIT; attempt += 1) {
    assert.throws(
      () => api.verifyPairChallenge(SERVICE.clientId, created.challengeId, "dev-1", "wrong-secret"),
      (error: unknown) => error instanceof DeviceControlError && error.status === 401,
    );
  }
  assert.throws(
    () => api.verifyPairChallenge(SERVICE.clientId, created.challengeId, "dev-1", "pair-secret-once-16"),
    (error: unknown) => error instanceof DeviceControlError && error.code === "challenge_locked",
  );

  const fresh = api.createPairChallenge(SERVICE.clientId, "dev-2");
  now = fresh.expiresAtMs;
  assert.throws(
    () => api.verifyPairChallenge(SERVICE.clientId, fresh.challengeId, "dev-2", "pair-secret-once-16"),
    (error: unknown) => error instanceof DeviceControlError && error.code === "challenge_expired",
  );

  const used = api.createPairChallenge(SERVICE.clientId, "dev-3");
  api.verifyPairChallenge(SERVICE.clientId, used.challengeId, "dev-3", "pair-secret-once-16");
  assert.throws(
    () => api.verifyPairChallenge(SERVICE.clientId, used.challengeId, "dev-3", "pair-secret-once-16"),
    (error: unknown) => error instanceof DeviceControlError && error.code === "challenge_used",
  );
  assert.equal(api.listDevices(SERVICE.clientId).some((device) => device.deviceId === "dev-3"), true);
  assert.equal(api.listDevices(OTHER.clientId).length, 0);
  assert.throws(() => api.getDevice(OTHER.clientId, "dev-3"), (error: unknown) => error instanceof DeviceControlError && error.status === 404);
});

test("apply stores the OpenBot grant ref and walks accepted, applying, active, or failed", () => {
  const api = control();
  pair(api);
  assert.throws(
    () =>
      api.applyBinding(SERVICE.clientId, "dev-missing", {
        authorizationRef: "grant-from-openbot",
        bindingVersion: 2,
        restrictedAuth: AUTH,
      }),
    (error: unknown) => error instanceof DeviceControlError && error.code === "device_missing",
  );
  const seen: string[] = [];
  const applied = api.applyBinding(
    SERVICE.clientId,
    "dev-1",
    { authorizationRef: "grant-from-openbot", bindingVersion: 2, restrictedAuth: AUTH },
    { onStatus: (status) => seen.push(status) },
  );
  assert.deepEqual(seen, ["accepted", "applying", "active"]);
  assert.equal(applied.authorizationRef, "grant-from-openbot");
  assert.equal(applied.bindingVersion, 2);
  assert.equal(applied.restrictedAuthStored, true);
  assert.equal(JSON.stringify(applied).includes(AUTH), false);
  assert.equal(api.getBinding(SERVICE.clientId, "dev-1").applyStatus, "active");

  const failed = api.applyBinding(SERVICE.clientId, "dev-1", {
    authorizationRef: "",
    bindingVersion: 0,
    restrictedAuth: "short",
  });
  assert.equal(failed.applyStatus, "failed");
  assert.equal(failed.authorizationRef, "");
});

test("stop clears sessions, play, tools, and credentials, including the control plane", () => {
  const plane = new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => "042315",
    authorizationRef: () => "aref_local",
    token: () => "ctok_1",
  });
  plane.redeemClaim("dev-1", plane.issueClaim("dev-1").code);
  plane.bind({ deviceId: "dev-1", digitalHumanId: "dh-local", assistant: { voiceId: "v" } });
  plane.issueConnectionCredential("dev-1");
  let closed = 0;
  plane.attachSessionLifecycle({
    invalidateDevice: () => {
      closed += 1;
      return 1;
    },
  });
  const api = control(() => 1_700_000_000_000, plane);
  pair(api);
  api.noteActivity(SERVICE.clientId, "dev-1", "session");
  api.noteActivity(SERVICE.clientId, "dev-1", "play");
  api.noteActivity(SERVICE.clientId, "dev-1", "tool");
  api.applyBinding(SERVICE.clientId, "dev-1", {
    authorizationRef: "grant-from-openbot",
    bindingVersion: 4,
    restrictedAuth: AUTH,
  });
  const report = api.stop(SERVICE.clientId, "dev-1");
  assert.equal(report.sessionsStopped, 1);
  assert.equal(report.playStopped, true);
  assert.equal(report.toolsStopped, 1);
  assert.equal(report.credentialsCleared, true);
  assert.equal(report.controlPlaneClearedTokens, 1);
  assert.equal(closed, 1);
  assert.equal(plane.isRevoked("dev-1"), true);
  assert.equal(api.getBinding(SERVICE.clientId, "dev-1").restrictedAuthStored, false);
  assert.equal(plane.getBinding("dev-1")?.authorizationRef, "aref_local");
  assert.throws(() => api.noteActivity(SERVICE.clientId, "dev-1", "play"), (error: unknown) => error instanceof DeviceControlError && error.code === "device_stopped");
});

test("status sync dedupes eventId and rejects firmware URLs and flash", () => {
  const api = control();
  pair(api);
  const body = {
    eventId: "evt-1",
    version: 1,
    online: true,
    lastSeen: "2026-10-20T00:00:00.000Z",
    capabilities: ["camera.capture"],
    firmware: "lab-label",
  };
  const first = api.syncStatus(SERVICE.clientId, "dev-1", body);
  assert.equal(first.duplicate, false);
  assert.equal(first.firmwareUrl, null);
  const replay = api.syncStatus(SERVICE.clientId, "dev-1", body);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.version, 1);
  assert.throws(
    () => api.syncStatus(SERVICE.clientId, "dev-1", { ...body, online: false }),
    (error: unknown) => error instanceof DeviceControlError && error.code === "status_conflict",
  );
  assert.throws(
    () => api.syncStatus(SERVICE.clientId, "dev-1", { ...body, eventId: "evt-2", version: 1 }),
    (error: unknown) => error instanceof DeviceControlError && error.code === "status_version",
  );
  const next = api.syncStatus(SERVICE.clientId, "dev-1", { ...body, eventId: "evt-2", version: 2, online: false });
  assert.equal(next.duplicate, false);
  assert.equal(next.online, false);
  assert.throws(
    () => api.syncStatus(SERVICE.clientId, "dev-1", { ...body, eventId: "evt-3", version: 3, firmware: "https://api.tenclass.net/ota" }),
    (error: unknown) => error instanceof DeviceControlError && error.code === "firmware_url",
  );
  assert.throws(
    () => api.syncStatus(SERVICE.clientId, "dev-1", { ...body, eventId: "evt-4", version: 4, capabilities: ["ota.flash"] }),
    (error: unknown) => error instanceof DeviceControlError && error.code === "flash_disabled",
  );
});

test("loopback HTTP requires service basic and hides other subjects", async () => {
  const api = control();
  assert.throws(() => startDeviceControlServer(api, { host: "0.0.0.0", port: 0 }), /loopback/);
  const server = await startDeviceControlServer(api, { host: "127.0.0.1", port: 0 });
  const authorization = `Basic ${Buffer.from("svc-ui:service-secret-16").toString("base64")}`;
  try {
    const health = await fetch(`${server.url}/api/device-control/v1/health`);
    assert.equal(health.status, 401);
    const capabilities = await fetch(`${server.url}/api/device-control/v1/capabilities`, { headers: { authorization } });
    assert.equal(capabilities.status, 200);
    const body = (await capabilities.json()) as { protocol: string; flash: boolean; entries: Array<{ id: string }> };
    assert.equal(body.protocol, "device-control.v1");
    assert.equal(body.flash, false);
    assert.deepEqual(
      body.entries.map((entry) => entry.id),
      ["device-control.discover", "device-control.pair", "device-control.control"],
    );
    const rejected = await fetch(`${server.url}/api/device-control/v1/pair-challenges`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "dev-9", userSubject: "browser-user" }),
    });
    assert.equal(rejected.status, 400);
    const createdResponse = await fetch(`${server.url}/api/device-control/v1/pair-challenges`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "dev-9" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { challengeId: string; secret: string };
    const verified = await fetch(`${server.url}/api/device-control/v1/pair-challenges/${created.challengeId}/verify`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "dev-9", secret: created.secret }),
    });
    assert.equal(verified.status, 200);
    const listed = await fetch(`${server.url}/api/device-control/v1/devices?userSubject=browser-user`, { headers: { authorization } });
    assert.equal(listed.status, 400);
    const okList = await fetch(`${server.url}/api/device-control/v1/devices`, { headers: { authorization } });
    const devices = (await okList.json()) as { devices: Array<{ deviceId: string }> };
    assert.deepEqual(devices.devices.map((device) => device.deviceId), ["dev-9"]);
    const other = await fetch(`${server.url}/api/device-control/v1/devices`, {
      headers: { authorization: `Basic ${Buffer.from("svc-other:other-service-16x").toString("base64")}` },
    });
    const otherBody = (await other.json()) as { devices: unknown[] };
    assert.equal(otherBody.devices.length, 0);
    const applied = await fetch(`${server.url}/api/device-control/v1/devices/dev-9/binding`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ authorizationRef: "grant-from-openbot", bindingVersion: 3, restrictedAuth: AUTH, digitalHumanId: "dh-browser" }),
    });
    assert.equal(applied.status, 400);
    const clean = await fetch(`${server.url}/api/device-control/v1/devices/dev-9/binding`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ authorizationRef: "grant-from-openbot", bindingVersion: 3, restrictedAuth: AUTH }),
    });
    assert.equal(clean.status, 200);
    const view = (await clean.json()) as { applyStatus: string; authorizationRef: string };
    assert.equal(view.applyStatus, "active");
    assert.equal(view.authorizationRef, "grant-from-openbot");
    const synced = await fetch(`${server.url}/api/device-control/v1/devices/dev-9/status`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        eventId: "evt-http",
        version: 1,
        online: true,
        lastSeen: "2026-10-20T00:00:00.000Z",
        capabilities: ["status"],
        firmware: "lab-label",
        firmwareUrl: "http://127.0.0.1/firmware.bin",
      }),
    });
    assert.equal(synced.status, 400);
  } finally {
    await server.close();
  }
});

test("contract draft names the three hardware entries and does not include OpenBot pairing fields", () => {
  const openapi = readFileSync(fileURLToPath(new URL("../contracts/device-control/openapi.yaml", import.meta.url)), "utf8");
  const doc = readFileSync(fileURLToPath(new URL("../docs/device-control.md", import.meta.url)), "utf8");
  for (const id of ["device-control.discover", "device-control.pair", "device-control.control"]) {
    assert.equal(openapi.includes(id), true);
    assert.equal(doc.includes(id), true);
  }
  assert.equal(openapi.includes("/api/integrations/v1/pair"), false);
  assert.equal(doc.includes("PR #10"), true);
  assert.equal(openapi.includes("firmwareUrl"), true);
  const help = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli, "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /127\.0\.0\.1:8792/);
  assert.match(help.stdout, /设备发现/);
  assert.match(help.stdout, /PR #10/);
  assert.equal(help.stdout.includes("api.tenclass.net"), true);
  assert.equal(help.stdout.includes("https://api.tenclass.net/xiaozhi"), false);
});
