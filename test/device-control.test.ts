import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GRANT_CREDENTIAL_HEADER,
  INTEGRATIONS_API_PREFIX,
  STUB_CONSENT_PASSWORD_ENV,
  STUB_CONSENT_USER_ENV,
  STUB_SERVICE_PASSWORD_ENV,
  STUB_SERVICE_USER_ENV,
  basicAuthorization,
  type AssistantFields,
} from "../contracts/src/index.ts";
import {
  codeChallengeS256,
  exchangeGrant,
  requestAuthorizationCode,
  type AuthorizationCodeInput,
  type ExchangeInput,
} from "../integrations/openbot-longitudinal/src/index.ts";
import { LIVE_STUB_ENV } from "../contracts/src/pin.ts";
import {
  ControlPlane,
  DEVICE_CONTROL_API_PREFIX,
  DEVICE_CONTROL_ROUTES,
  MemoryStagingDb,
  OtaDisabledError,
  deviceControlHealth,
  startDeviceControlServer,
  type GrantVerifier,
  type VerifiedGrantBinding,
} from "../services/src/index.ts";

const USER = "svc-ui";
const PASSWORD = "svc-secret";
const OTHER = "svc-other";
const OTHER_PASSWORD = "other-secret";
const PAIRING_CODE = "042315";
const GRANT_CREDENTIAL = "grant-from-exchange";
const ASSISTANT: AssistantFields = { digitalHumanId: "dh-1", displayName: "Lab", status: "active" };
const PAIR_KEYS = ["pairChallenge", "pairingChallenge", "pairingCode", "ownershipProof", "pairNonce"];

function plane(now = (): number => 1_700_000_000_000): { control: ControlPlane; minted: () => number } {
  let minted = 0;
  let ids = 0;
  const control = new ControlPlane({
    now,
    code: () => PAIRING_CODE,
    pairChallengeId: () => {
      ids += 1;
      return `pch_test_${ids.toString().padStart(8, "0")}`;
    },
    authorizationRef: () => {
      minted += 1;
      return `local_${minted}`;
    },
  });
  return { control, minted: () => minted };
}

function grant(overrides: Partial<VerifiedGrantBinding> = {}): VerifiedGrantBinding {
  return {
    authorizationRef: "aref-from-server",
    bindingVersion: 1,
    digitalHumanId: "dh-1",
    deviceId: "dev-1",
    status: "active",
    assistant: ASSISTANT,
    ...overrides,
  };
}

function basic(user = USER, password = PASSWORD): string {
  return basicAuthorization(user, password);
}

function headers(extra: Record<string, string> = {}, user = USER, password = PASSWORD): Record<string, string> {
  return { authorization: basic(user, password), ...extra };
}

async function post(url: string, body: unknown, user = USER, password = PASSWORD, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...headers(extra, user, password), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("device-control HTTP pairs, binds a verified grant, syncs, and stops", async () => {
  const { control, minted } = plane();
  let version = 1;
  let status = "active";
  const reads: string[] = [];
  const verifier: GrantVerifier = {
    async readGrant(input) {
      reads.push(input.authorizationRef);
      return grant({
        authorizationRef: "aref-from-server",
        bindingVersion: version,
        status,
        assistant: version === 1 ? ASSISTANT : { ...ASSISTANT, displayName: "Lab 2" },
      });
    },
  };
  assert.throws(() => startDeviceControlServer(control, { host: "0.0.0.0", port: 0 }), /non-loopback/);
  const server = await startDeviceControlServer(control, {
    host: "127.0.0.1",
    port: 0,
    serviceClients: [
      { user: USER, password: PASSWORD },
      { user: OTHER, password: OTHER_PASSWORD },
    ],
    grantVerifier: verifier,
  });
  try {
    const anonymous = await fetch(`${server.url}${DEVICE_CONTROL_API_PREFIX}/health`);
    assert.equal(anonymous.status, 401);
    assert.equal(((await anonymous.json()) as { error: string }).error, "unauthorized");
    const wrong = await fetch(`${server.url}${DEVICE_CONTROL_API_PREFIX}/health`, {
      headers: { authorization: basic(USER, "nope") },
    });
    assert.equal(wrong.status, 401);

    const health = (await (await fetch(`${server.url}${DEVICE_CONTROL_API_PREFIX}/health`, { headers: headers() })).json()) as {
      maturity: string;
      grayRelease: boolean;
      realDeviceDelivery: boolean;
      flash: boolean;
      massFlash: boolean;
      firmwareUrl: null;
      apiPrefix: string;
    };
    assert.equal(health.maturity, "v1-frozen");
    assert.equal(health.grayRelease, false);
    assert.equal(health.realDeviceDelivery, false);
    assert.equal(health.flash, false);
    assert.equal(health.massFlash, false);
    assert.equal(health.firmwareUrl, null);
    assert.equal(health.apiPrefix, DEVICE_CONTROL_API_PREFIX);

    const capabilities = (await (
      await fetch(`${server.url}${DEVICE_CONTROL_API_PREFIX}/capabilities`, { headers: headers() })
    ).json()) as {
      browserIdentity: boolean;
      routes: string[];
      openBot: { prefix: string; pairFieldsAccepted: boolean };
      ota: { flash: boolean; massFlash: boolean; firmwareUrl: null };
    };
    assert.equal(capabilities.browserIdentity, false);
    assert.deepEqual(capabilities.routes, [...DEVICE_CONTROL_ROUTES]);
    assert.equal(capabilities.routes.some((route) => route.includes(INTEGRATIONS_API_PREFIX)), false);
    assert.equal(capabilities.routes.some((route) => route.toLowerCase().includes("flash")), false);
    assert.equal(capabilities.openBot.prefix, INTEGRATIONS_API_PREFIX);
    assert.equal(capabilities.openBot.pairFieldsAccepted, false);
    assert.equal(capabilities.ota.flash, false);
    assert.equal(capabilities.ota.massFlash, false);
    assert.equal(capabilities.ota.firmwareUrl, null);

    const identity = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/pair-challenges`, {
      deviceId: "dev-1",
      userId: "browser-user",
      tenantId: "browser-tenant",
    });
    assert.equal(identity.status, 400);
    assert.equal(((await identity.json()) as { error: string }).error, "untrusted_identity");

    const created = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/pair-challenges`, { deviceId: "dev-1" });
    assert.equal(created.status, 201);
    const challenge = (await created.json()) as { pairChallenge: string; pairingCode: string; status: string };
    assert.equal(challenge.pairingCode, PAIRING_CODE);
    assert.equal(challenge.status, "pending");
    assert.match(challenge.pairChallenge, /^pch_/);

    const listed = await fetch(`${server.url}${DEVICE_CONTROL_API_PREFIX}/devices`, { headers: headers() });
    const listedText = await listed.text();
    assert.equal(listed.status, 200);
    assert.equal(listedText.includes(PAIRING_CODE), false);
    assert.equal(listedText.includes("pairingCode"), false);
    assert.equal(listedText.includes(challenge.pairChallenge), true);

    const wrongCode = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/pair-challenges/${challenge.pairChallenge}/redeem`, {
      deviceId: "dev-1",
      pairingCode: "000000",
    });
    assert.equal(wrongCode.status, 403);
    assert.equal(((await wrongCode.json()) as { error: string }).error, "pair_code");

    const redeemed = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/pair-challenges/${challenge.pairChallenge}/redeem`, {
      deviceId: "dev-1",
      pairingCode: PAIRING_CODE,
    });
    const redeemedText = await redeemed.text();
    assert.equal(redeemed.status, 200);
    assert.equal(redeemedText.includes(PAIRING_CODE), false);
    assert.equal(redeemedText.includes("pairingCode"), false);
    const ownership = JSON.parse(redeemedText) as { ownership: string; servicePrincipal: string };
    assert.equal(ownership.ownership, "verified");
    assert.equal(ownership.servicePrincipal, USER);

    const missingGrant = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind`, {
      authorizationRef: "aref-from-server",
    });
    assert.equal(missingGrant.status, 401);
    assert.equal(((await missingGrant.json()) as { error: string }).error, "grant_credential");
    assert.equal(reads.length, 0);

    const userId = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind`,
      { authorizationRef: "aref-from-server", userId: "browser-user", tenantId: "browser-tenant" },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(userId.status, 400);
    assert.equal(((await userId.json()) as { error: string }).error, "untrusted_identity");
    assert.equal(reads.length, 0);

    const leaked = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind`,
      { authorizationRef: "aref-from-server", pairChallenge: challenge.pairChallenge, pairingCode: PAIRING_CODE },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(leaked.status, 400);
    assert.equal(((await leaked.json()) as { error: string }).error, "pair_field");
    assert.equal(reads.length, 0);

    const mismatch = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind`,
      { authorizationRef: "aref-from-server", digitalHumanId: "dh-from-browser" },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(mismatch.status, 409);
    assert.equal(((await mismatch.json()) as { error: string }).error, "grant_mismatch");
    assert.equal(control.getBinding("dev-1"), undefined);

    const fakeRef = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind`,
      { authorizationRef: "aref-client-minted" },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(fakeRef.status, 409);
    assert.equal(((await fakeRef.json()) as { error: string }).error, "grant_ref");
    assert.equal(control.getBinding("dev-1"), undefined);
    assert.equal(minted(), 0);

    const bound = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind`,
      { authorizationRef: "aref-from-server", digitalHumanId: "dh-1" },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(bound.status, 200);
    const boundBody = (await bound.json()) as {
      authorizationRef: string;
      bindingVersion: number;
      digitalHumanId: string;
      source: string;
      bindStatus: string;
      servicePrincipal: string;
    };
    assert.equal(boundBody.authorizationRef, "aref-from-server");
    assert.equal(boundBody.bindingVersion, 1);
    assert.equal(boundBody.digitalHumanId, "dh-1");
    assert.equal(boundBody.source, "openbot-grant");
    assert.equal(boundBody.bindStatus, "bound");
    assert.equal(boundBody.servicePrincipal, USER);
    assert.equal(minted(), 0);
    assert.equal(control.getBinding("dev-1")?.authorizationRef, "aref-from-server");

    const otherList = await fetch(`${server.url}${DEVICE_CONTROL_API_PREFIX}/devices`, {
      headers: headers({}, OTHER, OTHER_PASSWORD),
    });
    assert.deepEqual(await otherList.json(), { devices: [] });
    const otherStop = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/stop`, {}, OTHER, OTHER_PASSWORD);
    assert.equal(otherStop.status, 403);

    control.issueConnectionCredential("dev-1");
    assert.equal(control.activeCredentialCount("dev-1"), 1);
    version = 2;
    const synced = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind/sync`,
      { authorizationRef: "aref-from-server" },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(synced.status, 200);
    const syncedBody = (await synced.json()) as { authorizationRef: string; bindingVersion: number; assistant: { displayName: string } };
    assert.equal(syncedBody.authorizationRef, "aref-from-server");
    assert.equal(syncedBody.bindingVersion, 2);
    assert.equal(syncedBody.assistant.displayName, "Lab 2");
    assert.equal(control.activeCredentialCount("dev-1"), 0);
    assert.equal(minted(), 0);

    const stopped = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/stop`, {});
    assert.equal(stopped.status, 200);
    const stoppedBody = (await stopped.json()) as { bindStatus: string; revoked: boolean; clearedTokens: number };
    assert.equal(stoppedBody.bindStatus, "revoked");
    assert.equal(stoppedBody.revoked, true);
    assert.equal(stoppedBody.clearedTokens, 0);
    const again = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/revoke`, {});
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { clearedTokens: number }).clearedTokens, 0);

    const stuck = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind`,
      { authorizationRef: "aref-from-server" },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(stuck.status, 403);
    assert.equal(((await stuck.json()) as { error: string }).error, "bind_revoked");

    version = 3;
    status = "active";
    const rebound = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind/sync`,
      { authorizationRef: "aref-from-server" },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(rebound.status, 200);
    const reboundBody = (await rebound.json()) as { bindStatus: string; bindingVersion: number; authorizationRef: string };
    assert.equal(reboundBody.bindStatus, "bound");
    assert.equal(reboundBody.bindingVersion, 3);
    assert.equal(reboundBody.authorizationRef, "aref-from-server");
    assert.equal(minted(), 0);

    status = "revoked";
    const remoteRevoke = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind/sync`,
      { authorizationRef: "aref-from-server" },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(remoteRevoke.status, 200);
    assert.equal(((await remoteRevoke.json()) as { bindStatus: string }).bindStatus, "revoked");

    assert.throws(() => control.flash(), OtaDisabledError);
    assert.throws(() => control.massFlash(), OtaDisabledError);
    const flash = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/flash`, {});
    assert.equal(flash.status, 404);
    const integrations = await post(`${server.url}${INTEGRATIONS_API_PREFIX}/grants/exchange`, {
      authorizationCode: "code",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1/cb",
    });
    assert.equal(integrations.status, 404);
    assert.equal(((await integrations.json()) as { error: string }).error, "not_device_platform");
  } finally {
    await server.close();
  }
});

test("OpenBot grant read and consent helpers never send pair fields", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method: init?.method ?? "GET", ...(body === undefined ? {} : { body }) });
    if (url.endsWith("/consent/authorization-codes")) {
      return Response.json({
        authorizationCode: "code-1",
        state: "state-1",
        digitalHumanId: "dh-1",
        deviceId: "dev-1",
      });
    }
    if (url.endsWith("/grants/exchange")) {
      return Response.json({
        authorizationRef: "aref-from-server",
        bindingVersion: 1,
        digitalHumanId: "dh-1",
        deviceId: "dev-1",
        status: "active",
        assistant: ASSISTANT,
        authorizationCredential: GRANT_CREDENTIAL,
      });
    }
    if (url.endsWith("/grants/aref-from-server")) {
      return Response.json({
        authorizationRef: "aref-from-server",
        bindingVersion: 1,
        digitalHumanId: "dh-1",
        deviceId: "dev-1",
        status: "active",
        assistant: ASSISTANT,
      });
    }
    return new Response("missing", { status: 404 });
  };
  const env = {
    [LIVE_STUB_ENV]: "http://127.0.0.1:8787",
    [STUB_SERVICE_USER_ENV]: USER,
    [STUB_SERVICE_PASSWORD_ENV]: PASSWORD,
    [STUB_CONSENT_USER_ENV]: "consent-ui",
    [STUB_CONSENT_PASSWORD_ENV]: "consent-secret",
  };
  const { control, minted } = plane();
  const server = await startDeviceControlServer(control, { host: "127.0.0.1", port: 0, env, fetchImpl });
  try {
    const created = await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/pair-challenges`, { deviceId: "dev-1" });
    const challenge = (await created.json()) as { pairChallenge: string; pairingCode: string };
    await post(`${server.url}${DEVICE_CONTROL_API_PREFIX}/pair-challenges/${challenge.pairChallenge}/redeem`, {
      deviceId: "dev-1",
      pairingCode: challenge.pairingCode,
    });
    const before = calls.length;
    const bound = await post(
      `${server.url}${DEVICE_CONTROL_API_PREFIX}/devices/dev-1/bind`,
      { authorizationRef: "aref-from-server" },
      USER,
      PASSWORD,
      { [GRANT_CREDENTIAL_HEADER]: GRANT_CREDENTIAL },
    );
    assert.equal(bound.status, 200);
    assert.equal(minted(), 0);
    const grantCall = calls.slice(before).find((call) => call.url.includes("/grants/aref-from-server"));
    assert.equal(grantCall?.method, "GET");
    assert.equal(grantCall?.body, undefined);
    assert.equal(grantCall?.url.includes(INTEGRATIONS_API_PREFIX), true);

    const consent: AuthorizationCodeInput = {
      serviceAudience: "aud",
      redirectUri: "http://127.0.0.1/cb",
      codeChallenge: codeChallengeS256("verifier-verifier-verifier-verifier-verifier-x"),
      codeChallengeMethod: "S256",
      digitalHumanId: "dh-1",
      deviceId: "dev-1",
      scopes: ["device.talk"],
      state: "state-1",
    };
    await requestAuthorizationCode(
      { ...consent, pairChallenge: challenge.pairChallenge, pairingCode: challenge.pairingCode } as AuthorizationCodeInput,
      { env, fetchImpl },
    );
    const exchange: ExchangeInput = {
      authorizationCode: "code-1",
      codeVerifier: "verifier-verifier-verifier-verifier-verifier-x",
      redirectUri: "http://127.0.0.1/cb",
      idempotencyKey: "exchange-1",
    };
    await exchangeGrant(
      { ...exchange, pairChallenge: challenge.pairChallenge, pairingCode: challenge.pairingCode } as ExchangeInput,
      { env, fetchImpl },
    );
    for (const call of calls) {
      const body = call.body ?? "";
      for (const key of PAIR_KEYS) {
        assert.equal(body.includes(key), false, key);
      }
      assert.equal(body.includes(challenge.pairChallenge), false);
      assert.equal(body.includes(challenge.pairingCode), false);
    }
  } finally {
    await server.close();
  }
});

test("pair challenge expiry, grant pair fields, and staging reload stay on the control plane", () => {
  let now = 1_700_000_000_000;
  const { control, minted } = plane(() => now);
  const created = control.createPairChallenge("dev-1", USER);
  now = created.expiresAtMs + 1;
  assert.throws(
    () =>
      control.redeemPairChallenge({
        pairChallenge: created.pairChallenge,
        deviceId: "dev-1",
        pairingCode: created.pairingCode,
        servicePrincipal: USER,
      }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "pair_expired",
  );

  const fresh = plane();
  const ticket = fresh.control.createPairChallenge("dev-1", USER);
  fresh.control.redeemPairChallenge({
    pairChallenge: ticket.pairChallenge,
    deviceId: "dev-1",
    pairingCode: ticket.pairingCode,
    servicePrincipal: USER,
  });
  assert.throws(
    () =>
      fresh.control.applyVerifiedGrant(USER, {
        ...grant(),
        assistant: { ...ASSISTANT, pairChallenge: "pch_inside_grant" },
      }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "pair_field",
  );
  const applied = fresh.control.applyVerifiedGrant(USER, grant());
  assert.equal(applied.source, "openbot-grant");
  assert.equal(applied.authorizationRef, "aref-from-server");
  assert.equal(fresh.minted(), 0);
  assert.equal(JSON.stringify(fresh.control.listDevicesForPrincipal(USER)).includes("pairingCode"), false);

  const store = new MemoryStagingDb();
  const first = new ControlPlane({
    store,
    now: () => 1_700_000_000_000,
    code: () => PAIRING_CODE,
    pairChallengeId: () => "pch_reload_0001",
    authorizationRef: () => {
      throw new Error("minted");
    },
  });
  const reloadedTicket = first.createPairChallenge("dev-9", USER);
  first.redeemPairChallenge({
    pairChallenge: reloadedTicket.pairChallenge,
    deviceId: "dev-9",
    pairingCode: reloadedTicket.pairingCode,
    servicePrincipal: USER,
  });
  first.applyVerifiedGrant(USER, grant({ deviceId: "dev-9" }));
  const second = new ControlPlane({
    store,
    now: () => 1_700_000_000_000,
    authorizationRef: () => {
      throw new Error("minted");
    },
  });
  const listed = second.listDevicesForPrincipal(USER);
  assert.equal(listed[0]?.deviceId, "dev-9");
  assert.equal(listed[0]?.authorizationRef, "aref-from-server");
  assert.equal(listed[0]?.source, "openbot-grant");
  assert.equal(JSON.stringify(listed).includes(PAIRING_CODE), false);
  assert.throws(() => second.flash(), OtaDisabledError);
  assert.throws(() => second.massFlash(), OtaDisabledError);
  assert.equal(minted(), 0);
});

test("device-control OpenAPI info.version and health maturity are frozen v1", () => {
  const yaml = readFileSync(new URL("../contracts/device-platform/device-control.openapi.yaml", import.meta.url), "utf8");
  assert.match(yaml, /^  version: v1$/m);
  assert.match(yaml, /enum: \[v1-frozen\]/);
  assert.equal(yaml.includes("agent-b-freeze-draft"), false);
  assert.equal(yaml.includes("v1-draft"), false);
  assert.match(yaml, /name: X-OpenBot-Grant-Credential/);
  assert.match(yaml, /\/api\/device-platform\/v1/);
  assert.match(yaml, /authorizationRef:/);
  assert.match(yaml, /grayRelease:/);
  assert.match(yaml, /realDeviceDelivery:/);
  assert.equal(deviceControlHealth().maturity, "v1-frozen");
});

test("device-control CLI help states the frozen v1 boundary", () => {
  const help = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "services/src/device-control-cli.ts", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\/api\/device-platform\/v1/);
  assert.match(help.stdout, /v1-frozen/);
  assert.match(help.stdout, /不是灰度/);
  const env = { ...process.env };
  delete env[STUB_SERVICE_USER_ENV];
  delete env[STUB_SERVICE_PASSWORD_ENV];
  const missing = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "services/src/device-control-cli.ts"],
    { encoding: "utf8", env },
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /OPENBOT_STUB_SERVICE_USER/);
});
