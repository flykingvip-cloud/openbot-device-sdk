import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GRANT_CREDENTIAL_HEADER,
  INTEGRATIONS_API_PREFIX,
  LIVE_STUB_ENV,
  STUB_AUTH_STATE_ENV,
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
  basicAuthorization,
} from "../contracts/src/index.ts";
import { codeChallengeS256 } from "../integrations/openbot-longitudinal/src/index.ts";
import { SIM_JOINT_PENDING, formatSimJointReport, runSimJointLoopback, simJointMissingEnv } from "../services/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = "services/src/sim-joint-cli.ts";
const USER = "svc-ui";
const PASSWORD = "svc-secret";
const CONSENT_USER = "consent-ui";
const CONSENT_PASSWORD = "consent-secret";
const DEVICE_ID = "dev-sim-1";
const DIGITAL_HUMAN_A = "dh-a";
const DIGITAL_HUMAN_B = "dh-b";
const VERIFIER = "verifier-verifier-verifier-verifier-verifier-x";
const AUTHORIZATION_REF = "aref_sim_joint";
const GRANT_CREDENTIAL = "cred-sim-joint-once";
const AUTHORIZATION_CODE = "code-sim-joint";
const PAIR_KEYS = ["pairChallenge", "pairingChallenge", "pairingCode", "ownershipProof", "pairNonce"];

interface StoredGrant {
  authorizationRef: string;
  authorizationCredential: string;
  bindingVersion: number;
  digitalHumanId: string;
  deviceId: string;
  status: "active" | "revoked";
  scopes: string[];
}

test("sim-joint CLI skips without stub credentials and does not claim a pass", () => {
  const help = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli, "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /127\.0\.0\.1:8787/);
  assert.match(help.stdout, /127\.0\.0\.1:8791/);
  assert.match(help.stdout, /sim \/ API-only/);
  assert.match(help.stdout, /JOINT_PENDING/);
  assert.equal(help.stdout.includes("api.tenclass.net"), false);

  const env = { ...process.env };
  for (const name of [
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
  ]) {
    delete env[name];
  }
  assert.equal(simJointMissingEnv(env).includes(LIVE_STUB_ENV), true);
  const skipped = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /跳过 sim \/ API-only/);
  assert.match(skipped.stdout, /JOINT_PENDING/);
  assert.match(skipped.stdout, /跳过不是通过/);
  assert.equal(skipped.stdout.includes(AUTHORIZATION_REF), false);
});

test("sim joint loopback rebinds and revoke stops the old grant", async () => {
  const calls: string[] = [];
  const bodies: string[] = [];
  let pending: { codeChallenge: string; redirectUri: string; digitalHumanId: string; deviceId: string; state: string; scopes: string[] } | undefined;
  let grant: StoredGrant | undefined;
  const server = createServer((req, res) => {
    void handleStub(req, res).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: { code: "RUN_FAILED", message: "stub failed", retryable: false } });
      }
    });
  });

  async function handleStub(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    calls.push(`${req.method ?? "GET"} ${path}`);
    const bodyText = await readBody(req);
    if (bodyText.length > 0) {
      bodies.push(bodyText);
    }
    const body = parseObject(bodyText);
    if (body !== undefined && PAIR_KEYS.some((key) => key in body)) {
      writeJson(res, 400, { error: { code: "PARAM_UNSUPPORTED", message: "pair fields are not OpenBot fields", retryable: false } });
      return;
    }
    if (path === `${INTEGRATIONS_API_PREFIX}/consent/authorization-codes` && req.method === "POST") {
      if (!authorized(req, CONSENT_USER, CONSENT_PASSWORD) || body === undefined) {
        writeJson(res, 401, { error: { code: "AUTH_INVALID", message: "consent basic is required", retryable: false } });
        return;
      }
      if (body.codeChallengeMethod !== "S256" || typeof body.codeChallenge !== "string") {
        writeJson(res, 400, { error: { code: "PARAM_UNSUPPORTED", message: "codeChallengeMethod must be S256", retryable: false } });
        return;
      }
      pending = {
        codeChallenge: body.codeChallenge,
        redirectUri: requireText(body, "redirectUri"),
        digitalHumanId: requireText(body, "digitalHumanId"),
        deviceId: requireText(body, "deviceId"),
        state: requireText(body, "state"),
        scopes: stringList(body.scopes),
      };
      writeJson(res, 201, {
        authorizationCode: AUTHORIZATION_CODE,
        state: pending.state,
        digitalHumanId: pending.digitalHumanId,
        deviceId: pending.deviceId,
      });
      return;
    }
    if (path === `${INTEGRATIONS_API_PREFIX}/grants/exchange` && req.method === "POST") {
      if (!authorized(req, USER, PASSWORD) || body === undefined || pending === undefined) {
        writeJson(res, 401, { error: { code: "AUTH_INVALID", message: "exchange requires service basic and a code", retryable: false } });
        return;
      }
      const verifier = requireText(body, "codeVerifier");
      if (body.authorizationCode !== AUTHORIZATION_CODE || body.redirectUri !== pending.redirectUri || codeChallengeS256(verifier) !== pending.codeChallenge) {
        writeJson(res, 401, { error: { code: "AUTH_INVALID", message: "PKCE exchange did not match the consent", retryable: false } });
        return;
      }
      grant = {
        authorizationRef: AUTHORIZATION_REF,
        authorizationCredential: GRANT_CREDENTIAL,
        bindingVersion: 1,
        digitalHumanId: pending.digitalHumanId,
        deviceId: pending.deviceId,
        status: "active",
        scopes: pending.scopes,
      };
      writeJson(res, 200, { ...grantView(grant), authorizationCredential: GRANT_CREDENTIAL, disposition: "accepted" });
      return;
    }
    const grantPath = new RegExp(`^${INTEGRATIONS_API_PREFIX}/grants/([^/]+)(?:/(rebind|revoke))?$`).exec(path);
    if (grantPath !== null && grant !== undefined) {
      const ref = decodeURIComponent(grantPath[1] ?? "");
      const action = grantPath[2];
      if (ref !== grant.authorizationRef) {
        writeJson(res, 404, { error: { code: "OBJECT_NOT_FOUND", message: "grant is not on this stub", retryable: false } });
        return;
      }
      if (action === "rebind" && req.method === "POST") {
        if (!authorized(req, CONSENT_USER, CONSENT_PASSWORD) || body === undefined) {
          writeJson(res, 401, { error: { code: "AUTH_INVALID", message: "rebind requires consent basic", retryable: false } });
          return;
        }
        grant.digitalHumanId = requireText(body, "digitalHumanId");
        grant.bindingVersion += 1;
        writeJson(res, 200, grantView(grant));
        return;
      }
      if (action === "revoke" && req.method === "POST") {
        if (!serviceGrant(req)) {
          return;
        }
        grant.status = "revoked";
        writeJson(res, 200, {
          authorizationRef: grant.authorizationRef,
          bindingVersion: grant.bindingVersion,
          digitalHumanId: grant.digitalHumanId,
          deviceId: grant.deviceId,
          status: "revoked",
        });
        return;
      }
      if (action === undefined && req.method === "GET") {
        if (!serviceGrant(req)) {
          return;
        }
        writeJson(res, 200, grantView(grant));
        return;
      }
    }
    if (path === `${INTEGRATIONS_API_PREFIX}/conversations` && req.method === "POST") {
      if (!serviceGrant(req)) {
        return;
      }
      if (grant === undefined) {
        writeJson(res, 404, { error: { code: "OBJECT_NOT_FOUND", message: "grant is not on this stub", retryable: false } });
        return;
      }
      if (grant.status === "revoked") {
        writeJson(res, 403, { error: { code: "AUTH_REVOKED", message: "grant is revoked", retryable: false } });
        return;
      }
      writeJson(res, 201, {
        conversationId: "conv-sim-joint",
        authorizationRef: grant.authorizationRef,
        digitalHumanId: grant.digitalHumanId,
        deviceId: grant.deviceId,
        bindingVersion: grant.bindingVersion,
      });
      return;
    }
    writeJson(res, 404, { error: { code: "OBJECT_NOT_FOUND", message: "unknown stub route", retryable: false } });

    function serviceGrant(request: IncomingMessage): boolean {
      if (!authorized(request, USER, PASSWORD) || header(request, GRANT_CREDENTIAL_HEADER) !== GRANT_CREDENTIAL) {
        writeJson(res, 401, { error: { code: "AUTH_INVALID", message: "service basic and grant credential are required", retryable: false } });
        return false;
      }
      return true;
    }
  }

  const origin = await listen(server);
  try {
    const env = {
      [LIVE_STUB_ENV]: origin,
      [STUB_SERVICE_USER_ENV]: USER,
      [STUB_SERVICE_PASSWORD_ENV]: PASSWORD,
      [STUB_CONSENT_USER_ENV]: CONSENT_USER,
      [STUB_CONSENT_PASSWORD_ENV]: CONSENT_PASSWORD,
      [STUB_DIGITAL_HUMAN_ID_ENV]: DIGITAL_HUMAN_A,
      [STUB_DEVICE_ID_ENV]: DEVICE_ID,
      [STUB_SERVICE_AUDIENCE_ENV]: "device-platform",
      [STUB_REDIRECT_URI_ENV]: "http://127.0.0.1/cb",
      [STUB_SCOPES_ENV]: "device.talk",
      [STUB_AUTH_STATE_ENV]: "state-sim-1",
      [STUB_CODE_VERIFIER_ENV]: VERIFIER,
    };
    assert.equal(codeChallengeS256(VERIFIER), createHash("sha256").update(VERIFIER).digest("base64url"));
    const report = await runSimJointLoopback({ env, port: 0, digitalHumanIdB: DIGITAL_HUMAN_B });
    assert.equal(report.layer, "sim");
    assert.equal(report.proof, "api");
    assert.equal(report.maturity, "v1-frozen");
    assert.equal(report.authorizationRef, AUTHORIZATION_REF);
    assert.equal(report.bindingVersionBefore, 1);
    assert.equal(report.bindingVersionAfter, 2);
    assert.equal(report.digitalHumanIdAfter, DIGITAL_HUMAN_B);
    assert.equal(report.bindStatusAfterRevoke, "revoked");
    assert.equal(report.oldGrantStatus, 403);
    assert.equal(report.oldGrantErrorCode, "AUTH_REVOKED");
    assert.deepEqual(report.pending, [...SIM_JOINT_PENDING]);
    assert.equal(report.checks.length > 0, true);
    assert.equal(report.checks.every((check) => check.layer === "sim" && check.proof === "api" && check.ok), true);
    const printed = formatSimJointReport(report);
    assert.match(printed, /sim \/ API-only/);
    assert.match(printed, /JOINT_PENDING: UI、staging、real-device、production/);
    assert.equal(printed.includes(GRANT_CREDENTIAL), false);
    assert.equal(printed.includes("端到端通过"), false);

    const exchangeAt = calls.indexOf(`POST ${INTEGRATIONS_API_PREFIX}/grants/exchange`);
    const readAt = calls.indexOf(`GET ${INTEGRATIONS_API_PREFIX}/grants/${AUTHORIZATION_REF}`);
    const rebindAt = calls.indexOf(`POST ${INTEGRATIONS_API_PREFIX}/grants/${AUTHORIZATION_REF}/rebind`);
    const revokeAt = calls.indexOf(`POST ${INTEGRATIONS_API_PREFIX}/grants/${AUTHORIZATION_REF}/revoke`);
    const conversationAt = calls.indexOf(`POST ${INTEGRATIONS_API_PREFIX}/conversations`);
    assert.equal(calls.includes(`POST ${INTEGRATIONS_API_PREFIX}/consent/authorization-codes`), true);
    assert.equal(exchangeAt > 0, true);
    assert.equal(readAt > exchangeAt, true);
    assert.equal(rebindAt > readAt, true);
    assert.equal(revokeAt > rebindAt, true);
    assert.equal(calls.filter((call) => call === `POST ${INTEGRATIONS_API_PREFIX}/grants/${AUTHORIZATION_REF}/revoke`).length, 2);
    assert.equal(conversationAt > revokeAt, true);
    assert.equal(calls.some((call) => call.toLowerCase().includes("flash")), false);
    for (const body of bodies) {
      for (const key of PAIR_KEYS) {
        assert.equal(body.includes(`"${key}"`), false, key);
      }
    }
    assert.equal(grant?.status, "revoked");
    assert.equal(grant?.digitalHumanId, DIGITAL_HUMAN_B);
    assert.equal(grant?.bindingVersion, 2);
  } finally {
    await close(server);
  }
});

function grantView(grant: StoredGrant): Record<string, unknown> {
  return {
    authorizationRef: grant.authorizationRef,
    bindingVersion: grant.bindingVersion,
    digitalHumanId: grant.digitalHumanId,
    deviceId: grant.deviceId,
    status: grant.status,
    scopes: grant.scopes,
    assistant: {
      digitalHumanId: grant.digitalHumanId,
      displayName: "Sim",
      status: "active",
    },
  };
}

function authorized(req: IncomingMessage, user: string, password: string): boolean {
  return header(req, "authorization") === basicAuthorization(user, password);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is missing`);
  }
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("scopes must be strings");
  }
  return value as string[];
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("stub has no port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
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
