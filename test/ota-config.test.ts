import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OPENBOT_CONTRACT_SHA } from "../contracts/src/index.ts";
import { ControlPlane, ControlPlaneError, OtaDisabledError, openStaging } from "../services/src/index.ts";
import {
  LAB_DEVICE_PLATFORM_ENDPOINTS,
  LAB_DEVICE_PROOF_HEADER,
  LAB_VOICE_WSS_ENV,
  LAB_VOICE_WSS_URL,
  buildLabDeviceConfig,
  issueLabDeviceCredential,
  readLabDeviceCredential,
  refreshLabDeviceCredential,
  resolveLabVoiceWssUrl,
  startLabOtaConfigServer,
} from "../services/src/ota-config.ts";

const ASSISTANT = { voiceId: "voice-lab" };
const CLAIM_CODE = "042315";
const SECRET_KEYS = [
  "token",
  "tokenExpiresAtMs",
  "authorizationRef",
  "bindingVersion",
  "digitalHumanId",
  "gatewayAgentId",
  "agentSessionForce",
  "deviceApiUrl",
  "apiPrefix",
];

function plane(options: { store?: ReturnType<typeof openStaging>; now?: () => number } = {}): ControlPlane {
  let refs = 0;
  let tokens = 0;
  return new ControlPlane({
    now: options.now ?? (() => 1_700_000_000_000),
    code: () => CLAIM_CODE,
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
    token: () => {
      tokens += 1;
      return `ctok_${tokens}`;
    },
    ...(options.store ? { store: options.store } : {}),
  });
}

function claimAndBind(control: ControlPlane, deviceId = "dev-ota"): string {
  const ticket = control.issueClaim(deviceId);
  control.redeemClaim(deviceId, ticket.code);
  control.bind({ deviceId, digitalHumanId: "dh-ota", assistant: ASSISTANT });
  return ticket.code;
}

function assertPublic(body: object): void {
  for (const key of SECRET_KEYS) {
    assert.equal(Object.hasOwn(body, key), false, key);
  }
}

test("public config has pairing hints and never a token or auth profile", () => {
  const control = plane();
  const missing = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790", { env: {} });
  assert.equal(missing.contractSha, OPENBOT_CONTRACT_SHA);
  assert.equal(missing.contractSha, "fe1e2c2a81fd3814e8588a854695640ca56db64b");
  assert.equal(missing.routesAligned, true);
  assert.equal(missing.claimStatus, "missing");
  assert.equal(missing.pairing.next, "issue-claim");
  assert.equal(missing.firmwareUrl, null);
  assert.equal(missing.executable, false);
  assert.equal(missing.force, 0);
  assert.equal(missing.voiceWssUrl, LAB_VOICE_WSS_URL);
  assert.equal(missing.voiceWssUrl.includes("tenclass"), false);
  assert.equal(missing.devicePlatformUrl, "http://127.0.0.1:8790");
  assert.equal(missing.openBotConnectorUrl, null);
  assert.deepEqual(missing.devicePlatformEndpoints, LAB_DEVICE_PLATFORM_ENDPOINTS);
  assert.equal(missing.devicePlatformEndpoints.some((line) => line.includes("grants")), false);
  assert.equal(missing.devicePlatformEndpoints.some((line) => line.includes("conversations")), false);
  assert.equal(missing.devicePlatformEndpoints.some((line) => line.includes("runs")), false);
  assertPublic(missing);
  assert.equal(control.activeCredentialCount("dev-ota"), 0);

  const pending = control.issueClaim("dev-ota");
  assert.equal(pending.code, CLAIM_CODE);
  const issued = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790", { env: {} });
  assert.equal(issued.claimStatus, "pending");
  assert.equal(issued.pairing.next, "redeem-claim");
  assertPublic(issued);

  control.redeemClaim("dev-ota", pending.code);
  const claimed = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790", { env: {} });
  assert.equal(claimed.claimStatus, "claimed");
  assert.equal(claimed.pairing.next, "bind");
  assertPublic(claimed);

  control.bind({ deviceId: "dev-ota", digitalHumanId: "dh-ota", assistant: ASSISTANT });
  const bound = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790", { env: {} });
  assert.equal(bound.claimStatus, "claimed");
  assert.equal(bound.pairing.next, "present-claim-code");
  assertPublic(bound);
  assert.equal(control.activeCredentialCount("dev-ota"), 0);
  const again = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790", { env: {} });
  assertPublic(again);
  assert.equal(control.activeCredentialCount("dev-ota"), 0);

  assert.throws(() => control.flash(), OtaDisabledError);
  assert.throws(() => control.massFlash(), OtaDisabledError);

  assert.throws(
    () =>
      issueLabDeviceCredential(control, "dev-ota", "000000", {
        env: { OPENBOT_DEVICE_DH_GATEWAY_AGENT_ID: "agent-lab" },
      }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "device_proof",
  );
  assert.equal(control.activeCredentialCount("dev-ota"), 0);

  const credential = issueLabDeviceCredential(control, "dev-ota", CLAIM_CODE, {
    env: {
      OPENBOT_DEVICE_DH_GATEWAY_AGENT_ID: "agent-lab",
      OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE: "1",
    },
  });
  assert.equal(credential.token, "ctok_1");
  assert.equal(credential.tokenExpiresAtMs, 1_700_000_000_000 + 15 * 60 * 1000);
  assert.equal(credential.bindingVersion, 1);
  assert.equal(credential.authorizationRef, "aref_1");
  assert.equal(credential.digitalHumanId, "dh-ota");
  assert.equal(credential.gatewayAgentId, "agent-lab");
  assert.equal(credential.agentSessionForce, true);
  assert.equal(control.activeCredentialCount("dev-ota"), 1);
  const repeated = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790", { env: {} });
  assertPublic(repeated);
  assert.equal(control.activeCredentialCount("dev-ota"), 1);

  const notForced = readLabDeviceCredential(control, "dev-ota", credential.token, {
    env: { OPENBOT_DEVICE_DH_GATEWAY_AGENT_ID: "agent-lab", OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE: "true" },
  });
  assert.equal(notForced.agentSessionForce, false);
  assert.equal(notForced.token, "ctok_1");
});

test("connector URL is the stub, not this lab process", () => {
  const control = plane();
  const separated = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790/", {
    env: { OPENBOT_DEVICE_DH_STUB_URL: "http://127.0.0.1:8787" },
  });
  assert.equal(separated.devicePlatformUrl, "http://127.0.0.1:8790");
  assert.equal(separated.openBotConnectorUrl, "http://127.0.0.1:8787/api/integrations/v1");
  assert.notEqual(separated.devicePlatformUrl, separated.openBotConnectorUrl);
  assert.throws(
    () =>
      buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790", {
        env: { OPENBOT_DEVICE_DH_STUB_URL: "https://api.tenclass.net" },
      }),
    /loopback|tenclass/,
  );
});

test("revoke and rebind do not put the auth profile on public config", () => {
  const control = plane();
  const code = claimAndBind(control);
  const issued = issueLabDeviceCredential(control, "dev-ota", code, { env: {} });
  assert.equal(issued.token, "ctok_1");
  assert.equal(issued.bindingVersion, 1);

  control.revoke("dev-ota");
  const revoked = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:9", { env: {} });
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.pairing.next, "revoked");
  assertPublic(revoked);
  assert.equal(control.activeCredentialCount("dev-ota"), 0);
  assert.throws(
    () => readLabDeviceCredential(control, "dev-ota", issued.token, { env: {} }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_revoked",
  );

  const rebound = control.rebind("dev-ota", { assistant: { voiceId: "voice-next" } });
  assert.equal(rebound.bindingVersion, 2);
  const next = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:9", { env: {} });
  assert.equal(next.revoked, false);
  assert.equal(next.pairing.next, "present-claim-code");
  assertPublic(next);
  assert.equal(next.firmwareUrl, null);
  const rotated = issueLabDeviceCredential(control, "dev-ota", code, { env: {} });
  assert.equal(rotated.bindingVersion, 2);
  assert.equal(rotated.authorizationRef, "aref_2");
  assert.equal(rotated.token, "ctok_2");
  assert.throws(
    () => readLabDeviceCredential(control, "dev-ota", "ctok_1", { env: {} }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_missing",
  );
});

test("stored token is readable only with the token, including after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-ota-config-"));
  const path = join(dir, "ota.json");
  const firstStore = openStaging(path);
  const first = plane({ store: firstStore });
  const code = claimAndBind(first);
  assertPublic(buildLabDeviceConfig(first, "dev-ota", "http://127.0.0.1:9", { env: {} }));
  assert.equal(issueLabDeviceCredential(first, "dev-ota", code, { env: {} }).token, "ctok_1");
  firstStore.close();

  const secondStore = openStaging(path);
  const second = plane({ store: secondStore });
  const loaded = buildLabDeviceConfig(second, "dev-ota", "http://127.0.0.1:9", { env: {} });
  assert.equal(loaded.claimStatus, "claimed");
  assert.equal(loaded.pairing.next, "present-claim-code");
  assertPublic(loaded);
  assert.equal(readLabDeviceCredential(second, "dev-ota", "ctok_1", { env: {} }).token, "ctok_1");
  assert.equal(second.activeCredentialCount("dev-ota"), 1);
  second.revoke("dev-ota");
  secondStore.close();

  const third = plane({ store: openStaging(path) });
  const cleared = buildLabDeviceConfig(third, "dev-ota", "http://127.0.0.1:9", { env: {} });
  assertPublic(cleared);
  assert.equal(cleared.revoked, true);
  assert.equal(cleared.firmwareUrl, null);
  assert.equal(third.activeCredentialCount("dev-ota"), 0);
});

test("expired credential cannot be read, and refresh still requires the old token", () => {
  let now = 1_700_000_000_000;
  const control = plane({ now: () => now });
  const code = claimAndBind(control);
  const issued = issueLabDeviceCredential(control, "dev-ota", code, { env: {} });
  now = issued.tokenExpiresAtMs;
  assert.throws(
    () => readLabDeviceCredential(control, "dev-ota", issued.token, { env: {} }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_expired",
  );
  assert.throws(
    () => refreshLabDeviceCredential(control, "dev-ota", "", { env: {} }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_missing",
  );
  const refreshed = refreshLabDeviceCredential(control, "dev-ota", issued.token, { env: {} });
  assert.equal(refreshed.token, "ctok_2");
  assert.equal(refreshed.tokenExpiresAtMs, now + 15 * 60 * 1000);
  const decision = control.assessConnectionCredential("dev-ota", refreshed.token);
  assert.equal(decision.ok, true);
});

test("claimed config uses the lab voice URL and refuses production hosts", () => {
  const control = plane();
  claimAndBind(control);
  const lab = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790", {
    env: { [LAB_VOICE_WSS_ENV]: "ws://127.0.0.1:8791" },
  });
  assert.equal(lab.voiceWssUrl, "ws://127.0.0.1:8791");
  assert.equal(lab.claimStatus, "claimed");
  assertPublic(lab);
  const blocked = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790", {
    env: { [LAB_VOICE_WSS_ENV]: "wss://api.tenclass.net/xiaozhi/v1/" },
  });
  assert.equal(blocked.voiceWssUrl, LAB_VOICE_WSS_URL);
  assert.equal(resolveLabVoiceWssUrl({ [LAB_VOICE_WSS_ENV]: "wss://example.com/voice" }), LAB_VOICE_WSS_URL);
});

test("lab config HTTP keeps tokens off the public route and rejects non-loopback", async () => {
  const control = plane();
  assert.throws(() => startLabOtaConfigServer(control, { host: "0.0.0.0", port: 0 }), /non-loopback/);
  assert.throws(() => startLabOtaConfigServer(control, { host: "192.168.1.8", port: 0 }), /non-loopback/);
  const server = await startLabOtaConfigServer(control, { host: "127.0.0.1", port: 0, env: {} });
  try {
    const health = await fetch(`${server.url}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { ok: boolean; firmwareUrl: null };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.firmwareUrl, null);

    const before = await fetch(`${server.url}/devices/dev-ota/config`);
    assert.equal(before.status, 200);
    const unclaimed = (await before.json()) as { claimStatus: string; pairing: { next: string }; firmwareUrl: null };
    assert.equal(unclaimed.claimStatus, "missing");
    assert.equal(unclaimed.pairing.next, "issue-claim");
    assert.equal(unclaimed.firmwareUrl, null);
    assertPublic(unclaimed);

    const code = claimAndBind(control);
    const after = await fetch(`${server.url}/devices/dev-ota/config`);
    const bound = (await after.json()) as {
      pairing: { next: string };
      devicePlatformUrl: string;
      devicePlatformEndpoints: string[];
      openBotConnectorUrl: string | null;
      voiceWssUrl: string;
      routesAligned: boolean;
    };
    assert.equal(bound.pairing.next, "present-claim-code");
    assert.equal(bound.devicePlatformUrl, server.url);
    assert.equal(bound.openBotConnectorUrl, null);
    assert.equal(bound.devicePlatformEndpoints.includes("GET /healthz"), true);
    assert.equal(bound.devicePlatformEndpoints.some((line) => line.includes("/api/integrations/v1")), false);
    assert.equal(bound.voiceWssUrl, "wss://lab.invalid/voice");
    assert.equal(bound.routesAligned, true);
    assertPublic(bound);
    assert.equal(control.activeCredentialCount("dev-ota"), 0);

    const naked = await fetch(`${server.url}/devices/dev-ota/credentials`, { method: "POST" });
    assert.equal(naked.status, 401);
    const nakedBody = (await naked.json()) as { error: string };
    assert.equal(nakedBody.error, "device_proof");
    assert.equal(control.activeCredentialCount("dev-ota"), 0);

    const issued = await fetch(`${server.url}/devices/dev-ota/credentials`, {
      method: "POST",
      headers: { [LAB_DEVICE_PROOF_HEADER]: code },
    });
    assert.equal(issued.status, 200);
    const credential = (await issued.json()) as { token: string; bindingVersion: number; digitalHumanId: string };
    assert.equal(credential.token, "ctok_1");
    assert.equal(credential.bindingVersion, 1);
    assert.equal(credential.digitalHumanId, "dh-ota");

    const unread = await fetch(`${server.url}/devices/dev-ota/credentials`);
    assert.equal(unread.status, 401);
    const read = await fetch(`${server.url}/devices/dev-ota/credentials`, {
      headers: { authorization: "Bearer ctok_1" },
    });
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { token: string }).token, "ctok_1");

    const missingRefresh = await fetch(`${server.url}/devices/dev-ota/credentials/refresh`, { method: "POST" });
    assert.equal(missingRefresh.status, 401);
    const refreshed = await fetch(`${server.url}/devices/dev-ota/credentials/refresh`, {
      method: "POST",
      headers: { authorization: "Bearer ctok_1" },
    });
    assert.equal(refreshed.status, 200);
    assert.equal(((await refreshed.json()) as { token: string }).token, "ctok_2");

    control.revoke("dev-ota");
    const revoked = (await (await fetch(`${server.url}/devices/dev-ota/config`)).json()) as {
      pairing: { next: string };
    };
    assert.equal(revoked.pairing.next, "revoked");
    assertPublic(revoked);
    const denied = await fetch(`${server.url}/devices/dev-ota/credentials`, {
      headers: { authorization: "Bearer ctok_2" },
    });
    assert.equal(denied.status, 403);

    control.rebind("dev-ota");
    const reboundConfig = (await (await fetch(`${server.url}/devices/dev-ota/config`)).json()) as {
      pairing: { next: string };
      firmwareUrl: null;
    };
    assert.equal(reboundConfig.pairing.next, "present-claim-code");
    assert.equal(reboundConfig.firmwareUrl, null);
    assertPublic(reboundConfig);
    const rebound = await fetch(`${server.url}/devices/dev-ota/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimCode: code }),
    });
    assert.equal(rebound.status, 200);
    const reboundBody = (await rebound.json()) as { token: string; bindingVersion: number; firmwareUrl?: null };
    assert.equal(reboundBody.bindingVersion, 2);
    assert.equal(reboundBody.token, "ctok_3");
    assert.equal(reboundBody.firmwareUrl, undefined);

    const grants = await fetch(`${server.url}/api/integrations/v1/grants`);
    assert.equal(grants.status, 404);
    const runs = await fetch(`${server.url}/api/integrations/v1/conversations/c/runs`);
    assert.equal(runs.status, 404);
    const missingRoute = await fetch(`${server.url}/v1/device/ota`);
    assert.equal(missingRoute.status, 404);
  } finally {
    await server.close();
  }
});
