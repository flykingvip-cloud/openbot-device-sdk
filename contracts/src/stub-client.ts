import { Buffer } from "node:buffer";

import { INTEGRATIONS_API_PREFIX, STUB_ROOT_HEALTH_PATH } from "./consumer-mirror.ts";
import { LIVE_STUB_ENV } from "./pin.ts";

/** HTTP Basic user for the OpenAPI `serviceBasic` scheme. Value comes from openbot-vp staging.md. */
export const STUB_SERVICE_USER_ENV = "OPENBOT_STUB_SERVICE_USER";

/** HTTP Basic password for `serviceBasic`. Not stored in this repo. */
export const STUB_SERVICE_PASSWORD_ENV = "OPENBOT_STUB_SERVICE_PASSWORD";

/** HTTP Basic user for the OpenAPI `consentBasic` scheme. */
export const STUB_CONSENT_USER_ENV = "OPENBOT_STUB_CONSENT_USER";

/** HTTP Basic password for `consentBasic`. Not stored in this repo. */
export const STUB_CONSENT_PASSWORD_ENV = "OPENBOT_STUB_CONSENT_PASSWORD";

/** Value of `X-OpenBot-Grant-Credential`. Not stored in this repo. */
export const STUB_GRANT_CREDENTIAL_ENV = "OPENBOT_STUB_GRANT_CREDENTIAL";

export const STUB_DIGITAL_HUMAN_ID_ENV = "OPENBOT_DEVICE_DH_STUB_ID";

export const STUB_AUTHORIZATION_REF_ENV = "OPENBOT_STUB_AUTHORIZATION_REF";

export const STUB_BINDING_VERSION_ENV = "OPENBOT_STUB_BINDING_VERSION";

export const STUB_DEVICE_ID_ENV = "OPENBOT_STUB_DEVICE_ID";

/** Header name from the vendored `grantCredential` security scheme. */
export const GRANT_CREDENTIAL_HEADER = "X-OpenBot-Grant-Credential";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface StubLocation {
  /** Origin only, for `GET /healthz`. */
  origin: string;
  /** Origin plus `/api/integrations/v1`. */
  integrationsBase: string;
  healthPath: typeof STUB_ROOT_HEALTH_PATH;
}

export function basicAuthorization(user: string, password: string): string {
  if (user.length === 0 || user.includes(":")) {
    throw new Error("stub basic user is empty or contains ':'");
  }
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

/**
 * Accepts only a loopback stub URL. Secrets in the userinfo are rejected.
 * A path of `/api/integrations/v1` is stripped so healthz stays on the origin.
 */
export function resolveStubLocation(raw: string): StubLocation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OPENBOT_DEVICE_DH_STUB_URL is not a URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("OPENBOT_DEVICE_DH_STUB_URL must not carry basic credentials");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OPENBOT_DEVICE_DH_STUB_URL must be http or https");
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("tenclass") || !LOOPBACK_HOSTS.has(host)) {
    throw new Error("OPENBOT_DEVICE_DH_STUB_URL must be a loopback host");
  }
  const path = url.pathname.replace(/\/$/, "");
  if (path.length > 0 && path !== INTEGRATIONS_API_PREFIX) {
    throw new Error("OPENBOT_DEVICE_DH_STUB_URL path must be empty or /api/integrations/v1");
  }
  const origin = `${url.protocol}//${url.host}`;
  return {
    origin,
    integrationsBase: `${origin}${INTEGRATIONS_API_PREFIX}`,
    healthPath: STUB_ROOT_HEALTH_PATH,
  };
}

export function stubLocationFromEnv(env: NodeJS.ProcessEnv): StubLocation | undefined {
  const raw = env[LIVE_STUB_ENV];
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return resolveStubLocation(raw);
}

export interface BasicClient {
  user: string;
  password: string;
  authorization: string;
}

function readBasic(env: NodeJS.ProcessEnv, userEnv: string, passwordEnv: string): BasicClient | undefined {
  const user = env[userEnv];
  const password = env[passwordEnv];
  if (user === undefined && password === undefined) {
    return undefined;
  }
  if (user === undefined || password === undefined || user.length === 0 || password.length === 0) {
    throw new Error(`${userEnv} and ${passwordEnv} must both be set`);
  }
  return { user, password, authorization: basicAuthorization(user, password) };
}

/** Service-role client. Undefined when both env vars are unset. */
export function serviceBasicFromEnv(env: NodeJS.ProcessEnv): BasicClient | undefined {
  return readBasic(env, STUB_SERVICE_USER_ENV, STUB_SERVICE_PASSWORD_ENV);
}

/** Consent-role client. Undefined when both env vars are unset. */
export function consentBasicFromEnv(env: NodeJS.ProcessEnv): BasicClient | undefined {
  return readBasic(env, STUB_CONSENT_USER_ENV, STUB_CONSENT_PASSWORD_ENV);
}

/**
 * Headers for routes that require `serviceBasic` and `grantCredential`.
 * Undefined when the service client and grant credential are all unset.
 */
export function serviceGrantHeaders(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const service = serviceBasicFromEnv(env);
  const grant = env[STUB_GRANT_CREDENTIAL_ENV];
  const grantSet = grant !== undefined && grant.length > 0;
  if (service === undefined && !grantSet) {
    return undefined;
  }
  if (service === undefined || !grantSet || grant === undefined) {
    throw new Error("service basic and X-OpenBot-Grant-Credential must be set together");
  }
  return {
    Authorization: service.authorization,
    [GRANT_CREDENTIAL_HEADER]: grant,
  };
}
