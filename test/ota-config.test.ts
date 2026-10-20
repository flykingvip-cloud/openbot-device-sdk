import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OPENBOT_CONTRACT_SHA } from "../contracts/src/index.ts";
import { ControlPlane, OtaDisabledError, openStaging } from "../services/src/index.ts";
import { LAB_VOICE_WSS_URL, buildLabDeviceConfig, startLabOtaConfigServer } from "../services/src/ota-config.ts";

const ASSISTANT = { voiceId: "voice-lab" };

function plane(options: { store?: ReturnType<typeof openStaging> } = {}): ControlPlane {
  let refs = 0;
  let tokens = 0;
  return new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => "042315",
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

function claimAndBind(control: ControlPlane, deviceId = "dev-ota"): void {
  control.redeemClaim(deviceId, control.issueClaim(deviceId).code);
  control.bind({ deviceId, digitalHumanId: "dh-ota", assistant: ASSISTANT });
}

test("config fetch distinguishes unclaimed and claimed, and never offers firmware", () => {
  const control = plane();
  const missing = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790");
  assert.equal(missing.contractSha, OPENBOT_CONTRACT_SHA);
  assert.equal(missing.contractSha, "536a963b119f0a00675516401c52dd0f6187b196");
  assert.equal(missing.routesAligned, false);
  assert.equal(missing.claimStatus, "missing");
  assert.equal(missing.token, null);
  assert.equal(missing.bindingVersion, null);
  assert.equal(missing.firmwareUrl, null);
  assert.equal(missing.executable, false);
  assert.equal(missing.force, 0);
  assert.equal(missing.voiceWssUrl, LAB_VOICE_WSS_URL);
  assert.equal(missing.voiceWssUrl.includes("tenclass"), false);
  assert.equal(missing.deviceApiUrl, "http://127.0.0.1:8790/api/integrations/v1");

  const pending = control.issueClaim("dev-ota");
  assert.equal(pending.code, "042315");
  const issued = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790");
  assert.equal(issued.claimStatus, "pending");
  assert.equal(issued.token, null);
  assert.equal(issued.bindingVersion, null);

  control.redeemClaim("dev-ota", pending.code);
  const claimed = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790");
  assert.equal(claimed.claimStatus, "claimed");
  assert.equal(claimed.token, null);
  assert.equal(claimed.bindingVersion, null);

  control.bind({ deviceId: "dev-ota", digitalHumanId: "dh-ota", assistant: ASSISTANT });
  const bound = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790");
  assert.equal(bound.claimStatus, "claimed");
  assert.equal(bound.bindingVersion, 1);
  assert.equal(bound.authorizationRef, "aref_1");
  assert.equal(bound.digitalHumanId, "dh-ota");
  assert.equal(bound.token, "ctok_1");
  assert.equal(bound.tokenExpiresAtMs, 1_700_000_000_000 + 15 * 60 * 1000);
  assert.equal(bound.firmwareUrl, null);
  const again = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:8790");
  assert.equal(again.token, "ctok_1");
  assert.equal(control.activeCredentialCount("dev-ota"), 1);

  assert.throws(() => control.flash(), OtaDisabledError);
  assert.throws(() => control.massFlash(), OtaDisabledError);
});

test("revoke clears the config token and rebind bumps bindingVersion", () => {
  const control = plane();
  claimAndBind(control);
  const bound = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:9");
  assert.equal(bound.token, "ctok_1");
  assert.equal(bound.bindingVersion, 1);

  control.revoke("dev-ota");
  const revoked = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:9");
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.token, null);
  assert.equal(revoked.tokenExpiresAtMs, null);
  assert.equal(revoked.bindingVersion, 1);
  assert.equal(control.activeCredentialCount("dev-ota"), 0);
  assert.equal(revoked.firmwareUrl, null);

  const rebound = control.rebind("dev-ota", { assistant: { voiceId: "voice-next" } });
  assert.equal(rebound.bindingVersion, 2);
  const next = buildLabDeviceConfig(control, "dev-ota", "http://127.0.0.1:9");
  assert.equal(next.revoked, false);
  assert.equal(next.bindingVersion, 2);
  assert.equal(next.authorizationRef, "aref_2");
  assert.equal(next.token, "ctok_2");
  assert.equal(next.tokenExpiresAtMs !== null, true);
  assert.equal(next.firmwareUrl, null);
});

test("config token survives a staging reopen until revoke", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-ota-config-"));
  const path = join(dir, "ota.json");
  const firstStore = openStaging(path);
  const first = plane({ store: firstStore });
  claimAndBind(first);
  assert.equal(buildLabDeviceConfig(first, "dev-ota", "http://127.0.0.1:9").token, "ctok_1");
  firstStore.close();

  const secondStore = openStaging(path);
  const second = plane({ store: secondStore });
  const loaded = buildLabDeviceConfig(second, "dev-ota", "http://127.0.0.1:9");
  assert.equal(loaded.claimStatus, "claimed");
  assert.equal(loaded.bindingVersion, 1);
  assert.equal(loaded.token, "ctok_1");
  second.revoke("dev-ota");
  secondStore.close();

  const third = plane({ store: openStaging(path) });
  const cleared = buildLabDeviceConfig(third, "dev-ota", "http://127.0.0.1:9");
  assert.equal(cleared.token, null);
  assert.equal(cleared.revoked, true);
  assert.equal(cleared.bindingVersion, 1);
  assert.equal(cleared.firmwareUrl, null);
});

test("lab config HTTP serves healthz and device config", async () => {
  const control = plane();
  const server = await startLabOtaConfigServer(control, { host: "127.0.0.1", port: 0 });
  try {
    const health = await fetch(`${server.url}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { ok: boolean; firmwareUrl: null };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.firmwareUrl, null);

    const before = await fetch(`${server.url}/devices/dev-ota/config`);
    assert.equal(before.status, 200);
    const unclaimed = (await before.json()) as { claimStatus: string; token: string | null; firmwareUrl: null };
    assert.equal(unclaimed.claimStatus, "missing");
    assert.equal(unclaimed.token, null);
    assert.equal(unclaimed.firmwareUrl, null);

    claimAndBind(control);
    const after = await fetch(`${server.url}/devices/dev-ota/config`);
    const bound = (await after.json()) as {
      bindingVersion: number;
      token: string;
      deviceApiUrl: string;
      voiceWssUrl: string;
      routesAligned: boolean;
    };
    assert.equal(bound.bindingVersion, 1);
    assert.equal(bound.token, "ctok_1");
    assert.equal(bound.deviceApiUrl, `${server.url}/api/integrations/v1`);
    assert.equal(bound.voiceWssUrl, "wss://lab.invalid/voice");
    assert.equal(bound.routesAligned, false);

    control.revoke("dev-ota");
    const revoked = (await (await fetch(`${server.url}/devices/dev-ota/config`)).json()) as { token: string | null };
    assert.equal(revoked.token, null);

    control.rebind("dev-ota");
    const rebound = (await (await fetch(`${server.url}/devices/dev-ota/config`)).json()) as {
      bindingVersion: number;
      token: string;
      firmwareUrl: null;
    };
    assert.equal(rebound.bindingVersion, 2);
    assert.equal(rebound.token, "ctok_2");
    assert.equal(rebound.firmwareUrl, null);

    const missingRoute = await fetch(`${server.url}/v1/device/ota`);
    assert.equal(missingRoute.status, 404);
  } finally {
    await server.close();
  }
});
