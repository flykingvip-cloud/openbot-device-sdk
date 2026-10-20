import {
  GRANT_CREDENTIAL_HEADER,
  INTEGRATIONS_API_PREFIX,
  LIVE_STUB_ENV,
  STUB_AUTH_STATE_ENV,
  STUB_AUTHORIZATION_CODE_ENV,
  STUB_CODE_VERIFIER_ENV,
  STUB_CONSENT_PASSWORD_ENV,
  STUB_CONSENT_USER_ENV,
  STUB_DEVICE_ID_ENV,
  STUB_DIGITAL_HUMAN_ID_ENV,
  STUB_REDIRECT_URI_ENV,
  STUB_SCOPES_ENV,
  STUB_SERVICE_AUDIENCE_ENV,
  STUB_SERVICE_PASSWORD_ENV,
  STUB_SERVICE_USER_ENV,
  serviceBasicFromEnv,
  stubLocationFromEnv,
} from "../../contracts/src/index.ts";
import {
  assertBindingVersion,
  codeChallengeS256,
  exchangeGrant,
  readGrant,
  rebindGrant,
  requestAuthorizationCode,
  revokeGrant,
} from "../../integrations/openbot-longitudinal/src/index.ts";
import { ControlPlane } from "./control-plane.ts";
import { DEVICE_CONTROL_API_PREFIX, startDeviceControlServer } from "./device-control.ts";

/** Evidence still missing after a sim / API-only loopback. Not an end-to-end pass. */
export const SIM_JOINT_PENDING = ["ui", "staging", "real-device", "production"] as const;

const REQUIRED_ENV = [
  LIVE_STUB_ENV,
  STUB_SERVICE_USER_ENV,
  STUB_SERVICE_PASSWORD_ENV,
  STUB_CONSENT_USER_ENV,
  STUB_CONSENT_PASSWORD_ENV,
  STUB_DIGITAL_HUMAN_ID_ENV,
  STUB_DEVICE_ID_ENV,
  STUB_SERVICE_AUDIENCE_ENV,
  STUB_REDIRECT_URI_ENV,
  STUB_SCOPES_ENV,
  STUB_AUTH_STATE_ENV,
  STUB_CODE_VERIFIER_ENV,
] as const;

export function simJointMissingEnv(env: NodeJS.ProcessEnv): string[] {
  return REQUIRED_ENV.filter((name) => {
    const value = env[name];
    return value === undefined || value.length === 0;
  });
}

export interface SimJointCheck {
  name: string;
  layer: "sim";
  proof: "api";
  ok: true;
}

export interface SimJointReport {
  layer: "sim";
  proof: "api";
  maturity: "v1-frozen";
  authorizationRef: string;
  bindingVersionBefore: number;
  bindingVersionAfter: number;
  digitalHumanIdAfter: string;
  bindStatusAfterRevoke: "revoked";
  oldGrantStatus: number;
  oldGrantErrorCode: string | undefined;
  checks: SimJointCheck[];
  pending: typeof SIM_JOINT_PENDING;
}

export interface SimJointOptions {
  env: NodeJS.ProcessEnv;
  /** Device-control listen port. `0` picks an ephemeral port. The CLI uses 8791. */
  port?: number;
  /** OpenBot rebind target. Omitted means the same digitalHumanId, still expecting bindingVersion++. */
  digitalHumanIdB?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Sim / API-only loopback: device-control on loopback plus the OpenBot stub in `env`.
 * Every check is an HTTP assertion. UI, staging, real voice, camera, and production stay pending.
 * The process does not mint `authorizationRef` and does not call flash or massFlash.
 */
export async function runSimJointLoopback(options: SimJointOptions): Promise<SimJointReport> {
  const missing = simJointMissingEnv(options.env);
  if (missing.length > 0) {
    throw new Error(`sim joint loopback missing env: ${missing.join(", ")}`);
  }
  if ((options.env[STUB_AUTHORIZATION_CODE_ENV] ?? "").length > 0) {
    throw new Error("sim joint loopback uses consent PKCE; do not set OPENBOT_STUB_AUTHORIZATION_CODE");
  }
  const service = serviceBasicFromEnv(options.env);
  if (service === undefined) {
    throw new Error("service basic is required");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const deviceId = requiredEnv(options.env, STUB_DEVICE_ID_ENV);
  const digitalHumanA = requiredEnv(options.env, STUB_DIGITAL_HUMAN_ID_ENV);
  const digitalHumanB = options.digitalHumanIdB !== undefined && options.digitalHumanIdB.length > 0
    ? options.digitalHumanIdB
    : digitalHumanA;
  const scopes = requiredEnv(options.env, STUB_SCOPES_ENV)
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  if (scopes.length === 0) {
    throw new Error("scopes must be a comma-separated list");
  }
  const checks: SimJointCheck[] = [];
  const mark = (name: string): void => {
    checks.push({ name, layer: "sim", proof: "api", ok: true });
  };
  const plane = new ControlPlane({
    authorizationRef: () => {
      throw new Error("device-control must not mint authorizationRef");
    },
  });
  const server = await startDeviceControlServer(plane, {
    host: "127.0.0.1",
    port: options.port ?? 8791,
    env: options.env,
    fetchImpl,
  });
  try {
    const health = await deviceJson(fetchImpl, server.url, "GET", "/health", service.authorization);
    if (
      health.maturity !== "v1-frozen" ||
      health.grayRelease !== false ||
      health.realDeviceDelivery !== false ||
      health.flash !== false ||
      health.massFlash !== false ||
      health.firmwareUrl !== null ||
      health.executable !== false
    ) {
      throw new Error("device-control health is not the frozen v1 marker");
    }
    mark("health maturity=v1-frozen，grayRelease / realDeviceDelivery / flash / massFlash 仍关闭");

    const capabilities = await deviceJson(fetchImpl, server.url, "GET", "/capabilities", service.authorization);
    assertCapabilities(capabilities);
    mark("capabilities 仍拒绝把 pair 字段送给 OpenBot，也没有 flash / massFlash");

    const created = await deviceJson(fetchImpl, server.url, "POST", "/pair-challenges", service.authorization, {
      deviceId,
    });
    const pairChallenge = requireString(created, "pairChallenge");
    const pairingCode = requireString(created, "pairingCode");
    mark("pair challenge 已创建");

    const redeemed = await deviceJson(
      fetchImpl,
      server.url,
      "POST",
      `/pair-challenges/${encodeURIComponent(pairChallenge)}/redeem`,
      service.authorization,
      { deviceId, pairingCode },
    );
    if (redeemed.ownership !== "verified" || redeemed.servicePrincipal !== service.user) {
      throw new Error("redeem did not verify ownership");
    }
    if (JSON.stringify(redeemed).includes("pairingCode") || JSON.stringify(redeemed).includes(pairingCode)) {
      throw new Error("redeem returned the pairing code");
    }
    mark("redeem 后 ownership=verified，响应不含 pairingCode");

    const live = { env: options.env, fetchImpl };
    const consent = await requestAuthorizationCode(
      {
        serviceAudience: requiredEnv(options.env, STUB_SERVICE_AUDIENCE_ENV),
        redirectUri: requiredEnv(options.env, STUB_REDIRECT_URI_ENV),
        codeChallenge: codeChallengeS256(requiredEnv(options.env, STUB_CODE_VERIFIER_ENV)),
        codeChallengeMethod: "S256",
        digitalHumanId: digitalHumanA,
        deviceId,
        scopes,
        state: requiredEnv(options.env, STUB_AUTH_STATE_ENV),
      },
      live,
    );
    mark("OpenBot consent 使用 PKCE S256，未发送 pairChallenge / pairingCode");

    const exchanged = await exchangeGrant(
      {
        authorizationCode: consent.authorizationCode,
        codeVerifier: requiredEnv(options.env, STUB_CODE_VERIFIER_ENV),
        redirectUri: requiredEnv(options.env, STUB_REDIRECT_URI_ENV),
        idempotencyKey: "sim-joint-exchange",
      },
      live,
    );
    const registered = await readGrant(exchanged.authorizationRef, live, exchanged.authorizationCredential);
    if (
      registered.authorizationRef !== exchanged.authorizationRef ||
      registered.deviceId !== deviceId ||
      registered.digitalHumanId !== digitalHumanA ||
      registered.bindingVersion !== exchanged.bindingVersion
    ) {
      throw new Error("grants/exchange did not register the grant on the same stub");
    }
    if (registered.status === "revoked") {
      throw new Error("fresh grant is already revoked");
    }
    mark("grants/exchange 在同一 stub 注册 grant，GET /grants/{authorizationRef} 可读");

    const bound = await deviceJson(
      fetchImpl,
      server.url,
      "POST",
      `/devices/${encodeURIComponent(deviceId)}/bind`,
      service.authorization,
      { authorizationRef: exchanged.authorizationRef },
      exchanged.authorizationCredential,
    );
    if (
      bound.authorizationRef !== exchanged.authorizationRef ||
      bound.bindStatus !== "bound" ||
      bound.source !== "openbot-grant" ||
      bound.digitalHumanId !== digitalHumanA ||
      bound.bindingVersion !== registered.bindingVersion
    ) {
      throw new Error("bind did not store the verified grant");
    }
    mark("device bind 带 X-OpenBot-Grant-Credential，authorizationRef 来自 exchange");

    const listed = await deviceJson(fetchImpl, server.url, "GET", "/devices", service.authorization);
    const status = await deviceJson(
      fetchImpl,
      server.url,
      "GET",
      `/devices/${encodeURIComponent(deviceId)}/bind`,
      service.authorization,
    );
    assertSameBinding(listed, status, deviceId, exchanged.authorizationRef, registered.bindingVersion, digitalHumanA, "bound");
    mark("list 与 bind status 是同一条 bound 记录");

    const rebound = await rebindGrant(exchanged.authorizationRef, digitalHumanB, live);
    if (rebound.authorizationRef !== exchanged.authorizationRef) {
      throw new Error("rebind changed authorizationRef");
    }
    if (rebound.bindingVersion <= registered.bindingVersion) {
      throw new Error("rebind did not increase bindingVersion");
    }
    if (rebound.digitalHumanId !== digitalHumanB || rebound.deviceId !== deviceId) {
      throw new Error("rebind did not keep the device and the requested digitalHumanId");
    }
    let oldVersionRejected = false;
    try {
      assertBindingVersion(rebound.bindingVersion, registered.bindingVersion);
    } catch (error) {
      oldVersionRejected = error instanceof Error && error.message.includes("old bindingVersion");
      if (!oldVersionRejected) {
        throw error;
      }
    }
    if (!oldVersionRejected) {
      throw new Error("old bindingVersion was accepted");
    }
    mark("OpenBot rebind 保持 authorizationRef，bindingVersion++；旧 bindingVersion 在本地被拒绝");

    const synced = await deviceJson(
      fetchImpl,
      server.url,
      "POST",
      `/devices/${encodeURIComponent(deviceId)}/bind/sync`,
      service.authorization,
      { authorizationRef: exchanged.authorizationRef },
      exchanged.authorizationCredential,
    );
    if (
      synced.authorizationRef !== exchanged.authorizationRef ||
      synced.bindingVersion !== rebound.bindingVersion ||
      synced.digitalHumanId !== digitalHumanB ||
      synced.bindStatus !== "bound"
    ) {
      throw new Error("bind/sync did not follow the rebind");
    }
    const listedAfter = await deviceJson(fetchImpl, server.url, "GET", "/devices", service.authorization);
    const statusAfter = await deviceJson(
      fetchImpl,
      server.url,
      "GET",
      `/devices/${encodeURIComponent(deviceId)}/bind`,
      service.authorization,
    );
    assertSameBinding(
      listedAfter,
      statusAfter,
      deviceId,
      exchanged.authorizationRef,
      rebound.bindingVersion,
      digitalHumanB,
      "bound",
    );
    mark("rebind 之后 list 与 bind status 同步到新的 bindingVersion 和 digitalHumanId");

    const revoked = await revokeGrant(exchanged.authorizationRef, live, exchanged.authorizationCredential);
    const revokedAgain = await revokeGrant(exchanged.authorizationRef, live, exchanged.authorizationCredential);
    if (
      revoked.status !== "revoked" ||
      revokedAgain.status !== "revoked" ||
      revoked.authorizationRef !== exchanged.authorizationRef ||
      revokedAgain.authorizationRef !== exchanged.authorizationRef
    ) {
      throw new Error("revoke did not stay revoked");
    }
    mark("OpenBot revoke 可重复调用，status 保持 revoked");

    const afterRevoke = await deviceJson(
      fetchImpl,
      server.url,
      "POST",
      `/devices/${encodeURIComponent(deviceId)}/bind/sync`,
      service.authorization,
      { authorizationRef: exchanged.authorizationRef },
      exchanged.authorizationCredential,
    );
    if (
      afterRevoke.bindStatus !== "revoked" ||
      afterRevoke.revoked !== true ||
      afterRevoke.authorizationRef !== exchanged.authorizationRef
    ) {
      throw new Error("bind/sync did not show revoked");
    }
    const listedRevoked = await deviceJson(fetchImpl, server.url, "GET", "/devices", service.authorization);
    const statusRevoked = await deviceJson(
      fetchImpl,
      server.url,
      "GET",
      `/devices/${encodeURIComponent(deviceId)}/bind`,
      service.authorization,
    );
    assertSameBinding(
      listedRevoked,
      statusRevoked,
      deviceId,
      exchanged.authorizationRef,
      rebound.bindingVersion,
      digitalHumanB,
      "revoked",
    );
    mark("OpenBot revoke 之后 bind/sync 与 list 显示 revoked");

    const oldGrant = await postConversation(
      options.env,
      fetchImpl,
      exchanged.authorizationRef,
      exchanged.authorizationCredential,
      deviceId,
      rebound.bindingVersion,
    );
    if (oldGrant.status >= 200 && oldGrant.status < 300) {
      throw new Error("revoked grant was still accepted");
    }
    mark("旧 grant 再创建 conversation 被拒绝");

    return {
      layer: "sim",
      proof: "api",
      maturity: "v1-frozen",
      authorizationRef: exchanged.authorizationRef,
      bindingVersionBefore: registered.bindingVersion,
      bindingVersionAfter: rebound.bindingVersion,
      digitalHumanIdAfter: digitalHumanB,
      bindStatusAfterRevoke: "revoked",
      oldGrantStatus: oldGrant.status,
      oldGrantErrorCode: oldGrant.errorCode,
      checks,
      pending: SIM_JOINT_PENDING,
    };
  } finally {
    await server.close();
  }
}

export function formatSimJointReport(report: SimJointReport): string {
  const code = report.oldGrantErrorCode === undefined ? "" : ` ${report.oldGrantErrorCode}`;
  return [
    "sim / API-only。这不是管理页面、staging、真机或生产通过。",
    `maturity: ${report.maturity}`,
    `authorizationRef: ${report.authorizationRef}`,
    `bindingVersion: ${report.bindingVersionBefore} -> ${report.bindingVersionAfter}`,
    `digitalHumanId: ${report.digitalHumanIdAfter}`,
    `revoke 之后 bindStatus: ${report.bindStatusAfterRevoke}`,
    `旧 grant conversation: HTTP ${report.oldGrantStatus}${code}`,
    ...report.checks.map((check) => `sim / API-only  ${check.name}`),
    "JOINT_PENDING: UI、staging、real-device、production。真语音和拍照不在这次 sim。",
    "管理页面可操作: JOINT_PENDING。设备实际已生效: JOINT_PENDING。",
  ].join("\n");
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertCapabilities(body: Record<string, unknown>): void {
  if (body.browserIdentity !== false) {
    throw new Error("capabilities still accept a browser identity");
  }
  const openBot = body.openBot;
  if (
    !isRecord(openBot) ||
    openBot.prefix !== INTEGRATIONS_API_PREFIX ||
    openBot.consent !== "pkce-s256" ||
    openBot.pairFieldsAccepted !== false
  ) {
    throw new Error("capabilities openBot boundary changed");
  }
  const routes = body.routes;
  if (!Array.isArray(routes) || routes.some((route) => typeof route === "string" && route.toLowerCase().includes("flash"))) {
    throw new Error("capabilities advertise flash");
  }
  const ota = body.ota;
  if (!isRecord(ota) || ota.flash !== false || ota.massFlash !== false || ota.firmwareUrl !== null) {
    throw new Error("capabilities ota flags changed");
  }
}

function assertSameBinding(
  list: Record<string, unknown>,
  status: Record<string, unknown>,
  deviceId: string,
  authorizationRef: string,
  bindingVersion: number,
  digitalHumanId: string,
  bindStatus: string,
): void {
  const row = findDevice(list, deviceId);
  for (const view of [row, status]) {
    if (view.deviceId !== deviceId || view.authorizationRef !== authorizationRef) {
      throw new Error("list and bind status diverged on authorizationRef");
    }
    if (view.bindingVersion !== bindingVersion || view.digitalHumanId !== digitalHumanId || view.bindStatus !== bindStatus) {
      throw new Error("list and bind status diverged");
    }
    if (JSON.stringify(view).includes("pairingCode")) {
      throw new Error("pairingCode leaked into a device view");
    }
  }
}

function findDevice(list: Record<string, unknown>, deviceId: string): Record<string, unknown> {
  const devices = list.devices;
  if (!Array.isArray(devices)) {
    throw new Error("device list is missing devices");
  }
  for (const item of devices) {
    if (isRecord(item) && item.deviceId === deviceId) {
      return item;
    }
  }
  throw new Error("device list does not contain the device");
}

async function postConversation(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  authorizationRef: string,
  grantCredential: string,
  deviceId: string,
  bindingVersion: number,
): Promise<{ status: number; errorCode: string | undefined }> {
  const location = stubLocationFromEnv(env);
  const service = serviceBasicFromEnv(env);
  if (location === undefined || service === undefined) {
    throw new Error("OpenBot stub is not configured");
  }
  const response = await fetchImpl(`${location.integrationsBase}/conversations`, {
    method: "POST",
    headers: {
      authorization: service.authorization,
      [GRANT_CREDENTIAL_HEADER]: grantCredential,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ authorizationRef, deviceId, bindingVersion }),
  });
  const text = await response.text();
  return { status: response.status, errorCode: errorCodeOf(text) };
}

async function deviceJson(
  fetchImpl: typeof fetch,
  origin: string,
  method: "GET" | "POST",
  path: string,
  authorization: string,
  body?: Record<string, unknown>,
  grantCredential?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    authorization,
    accept: "application/json",
  };
  if (grantCredential !== undefined) {
    headers[GRANT_CREDENTIAL_HEADER] = grantCredential;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetchImpl(`${origin}${DEVICE_CONTROL_API_PREFIX}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    throw new Error(`${method} ${path} returned a non-object (${response.status})`);
  }
  if (!response.ok) {
    const error = typeof parsed.error === "string" ? parsed.error : String(response.status);
    throw new Error(`${method} ${path} failed: ${response.status} ${error}`);
  }
  return parsed;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is missing`);
  }
  return value;
}

function errorCodeOf(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const error = parsed.error;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
    if (isRecord(error) && typeof error.code === "string" && error.code.length > 0) {
      return error.code;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
