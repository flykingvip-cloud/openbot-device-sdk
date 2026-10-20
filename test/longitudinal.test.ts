import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";

import {
  GRANT_CREDENTIAL_HEADER,
  LIVE_STUB_ENV,
  STUB_AUTHORIZATION_CODE_ENV,
  STUB_AUTHORIZATION_REF_ENV,
  STUB_BINDING_VERSION_ENV,
  STUB_CODE_VERIFIER_ENV,
  STUB_DEVICE_ID_ENV,
  STUB_DIGITAL_HUMAN_ID_ENV,
  STUB_GRANT_CREDENTIAL_ENV,
  STUB_REDIRECT_URI_ENV,
  STUB_SERVICE_PASSWORD_ENV,
  STUB_AUTH_STATE_ENV,
  STUB_CONSENT_PASSWORD_ENV,
  STUB_CONSENT_USER_ENV,
  STUB_SCOPES_ENV,
  STUB_SERVICE_AUDIENCE_ENV,
  STUB_SERVICE_USER_ENV,
  TEST_MODE_ENV,
  basicAuthorization,
  parseStubConfig,
} from "../contracts/src/index.ts";
import { GATEWAY_AGENT_ID_ENV, AGENT_SESSION_FORCE_ENV } from "../contracts/src/agent-session.ts";
import {
  LongitudinalError,
  codeChallengeS256,
  exchangeFromEnv,
  liveDialogueMode,
  liveTurnInputFromEnv,
  readDeviceEvents,
  rebindGrant,
  revokeGrant,
  runLiveTurn,
  speechFromEvent,
  submitToolResult,
  type RunEvent,
} from "../integrations/openbot-longitudinal/src/index.ts";

const IDENTITY = {
  authorizationRef: "aref-live",
  bindingVersion: 3,
  digitalHumanId: "dh-live",
  deviceId: "dev-live",
};

const ASSISTANT = {
  digitalHumanId: "dh-live",
  displayName: "Lab",
  status: "active",
};

const VERIFIER = "a".repeat(43);

const SERVICE_USER = "svc-user";
const SERVICE_PASSWORD = "svc-pass";
const BASIC = basicAuthorization(SERVICE_USER, SERVICE_PASSWORD);

interface Call {
  method: string;
  path: string;
  authorization: string | undefined;
  grant: string | undefined;
  idempotencyKey: string | undefined;
  body: unknown;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function envelope(type: string, extra: { text?: string; visibleText?: string; nested?: string } = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (extra.text !== undefined) {
    payload.text = extra.text;
  }
  if (extra.visibleText !== undefined) {
    payload.visibleText = extra.visibleText;
  }
  if (extra.nested !== undefined) {
    payload.assistant = { visibleText: extra.nested };
  }
  return {
    eventId: `evt-${type}`,
    type,
    payload,
    data: {},
    sequence: 1,
    runId: "run-1",
    turnId: "turn-1",
    conversationId: "conv-1",
  };
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

interface Stub {
  origin: string;
  calls: Call[];
  close: () => Promise<void>;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("longitudinal stub has no port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startStub(options: { holdEvents?: boolean } = {}): Promise<Stub> {
  const calls: Call[] = [];
  const turns = new Map<string, string>();
  let held: ServerResponse | undefined;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    sockets.add(req.socket);
    req.socket.on("close", () => {
      sockets.delete(req.socket);
    });
    void (async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const body = req.method === "GET" ? undefined : await readJson(req);
      const call: Call = {
        method: req.method ?? "",
        path,
        authorization: header(req, "authorization"),
        grant: header(req, "x-openbot-grant-credential"),
        idempotencyKey: header(req, "idempotency-key"),
        body,
      };
      calls.push(call);
      if (req.method === "POST" && path === "/api/integrations/v1/consent/authorization-codes") {
        const request = call.body as { state?: string; digitalHumanId?: string; deviceId?: string };
        sendJson(res, 201, {
          authorizationCode: "code-from-server",
          state: request.state,
          digitalHumanId: request.digitalHumanId,
          deviceId: request.deviceId,
          expiresAt: "2026-10-20T00:00:00.000Z",
        });
        return;
      }
      if (req.method === "POST" && path === "/api/integrations/v1/grants/exchange") {
        const request = call.body as { authorizationCode?: string };
        sendJson(res, 200, {
          ...IDENTITY,
          authorizationRef: request.authorizationCode === "code-from-server" ? "aref-from-server" : IDENTITY.authorizationRef,
          status: "active",
          assistant: ASSISTANT,
          authorizationCredential: "grant-exchanged",
          disposition: "accepted",
        });
        return;
      }
      if (path.startsWith("/api/integrations/v1/grants/") && path !== "/api/integrations/v1/grants/exchange") {
        const ref = decodeURIComponent(path.slice("/api/integrations/v1/grants/".length).split("/")[0] ?? "");
        if (req.method === "GET" && path.endsWith("/device-events")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            `data: ${JSON.stringify({ eventId: "evt-tool", type: "tool.request", payload: {}, data: {} })}\n\n` +
              `data: ${JSON.stringify({ eventId: "evt-revoked", type: "authorization.revoked", payload: {}, data: {} })}\n\n`,
          );
          return;
        }
        if (req.method === "POST" && path.endsWith("/revoke")) {
          sendJson(res, 200, { ...IDENTITY, authorizationRef: ref, status: "revoked" });
          return;
        }
        if (req.method === "POST" && path.endsWith("/rebind")) {
          sendJson(res, 200, {
            ...IDENTITY,
            authorizationRef: ref,
            bindingVersion: IDENTITY.bindingVersion + 1,
            status: "active",
            assistant: { ...ASSISTANT, voiceId: "ignored" },
          });
          return;
        }
        if (req.method === "GET") {
          sendJson(res, 200, {
            ...IDENTITY,
            authorizationRef: ref,
            status: "active",
            assistant: { ...ASSISTANT, voiceId: "ignored", evil: { admin: true } },
          });
          return;
        }
      }
      if (req.method === "POST" && path.startsWith("/api/integrations/v1/device-tool-requests/") && path.endsWith("/result")) {
        sendJson(res, 200, { duplicate: false, status: "ok" });
        return;
      }
      if (req.method === "POST" && path === "/api/integrations/v1/conversations") {
        sendJson(res, 200, { conversationId: "conv-1", ...IDENTITY, status: "open" });
        return;
      }
      if (req.method === "POST" && path === "/api/integrations/v1/conversations/conv-1/turns") {
        const key = call.idempotencyKey ?? "";
        const encoded = JSON.stringify(body);
        const previous = turns.get(key);
        if (previous !== undefined && previous !== encoded) {
          sendJson(res, 409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "different body", retryable: false } });
          return;
        }
        const duplicate = previous !== undefined;
        turns.set(key, encoded);
        sendJson(res, 202, {
          runId: "run-1",
          turnId: "turn-1",
          conversationId: "conv-1",
          disposition: duplicate ? "duplicate" : "accepted",
          ...IDENTITY,
        });
        return;
      }
      if (req.method === "GET" && path === "/api/integrations/v1/runs/run-1/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (options.holdEvents) {
          held = res;
          res.flushHeaders();
          return;
        }
        res.write(sse(envelope("assistant.delta", { text: "delta-secret" })));
        res.write(sse(envelope("assistant.visible", { text: "visible-line" })));
        res.write(sse(envelope("tool.request")));
        res.write(sse(envelope("assistant.final", { nested: "final-line" })));
        res.end(sse(envelope("run.completed")));
        return;
      }
      if (req.method === "POST" && path === "/api/integrations/v1/runs/run-1/cancel") {
        sendJson(res, 200, { runId: "run-1", accepted: true, status: "cancelled", sideEffectsRolledBack: false, reason: "barge_in" });
        if (held !== undefined) {
          held.end(sse(envelope("run.cancelled")));
          held = undefined;
        }
        return;
      }
      sendJson(res, 404, { error: { code: "OBJECT_NOT_FOUND", message: path, retryable: false } });
    })().catch((error: unknown) => {
      sendJson(res, 500, { error: { code: "INTERNAL", message: error instanceof Error ? error.message : "fail", retryable: false } });
    });
  });
  const origin = await listen(server);
  return {
    origin,
    calls,
    close: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      return close(server);
    },
  };
}

function envFor(origin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [LIVE_STUB_ENV]: origin,
    [STUB_SERVICE_USER_ENV]: SERVICE_USER,
    [STUB_SERVICE_PASSWORD_ENV]: SERVICE_PASSWORD,
    [STUB_GRANT_CREDENTIAL_ENV]: "grant-preset",
    [STUB_AUTHORIZATION_REF_ENV]: IDENTITY.authorizationRef,
    [STUB_BINDING_VERSION_ENV]: String(IDENTITY.bindingVersion),
    [STUB_DEVICE_ID_ENV]: IDENTITY.deviceId,
    [STUB_DIGITAL_HUMAN_ID_ENV]: IDENTITY.digitalHumanId,
    [GATEWAY_AGENT_ID_ENV]: "agent-lab",
    ...extra,
  };
}

test("speech is taken only from assistant.visible and assistant.final", () => {
  const delta: RunEvent = {
    eventId: "e1",
    type: "assistant.delta",
    payload: { text: "delta-secret" },
    data: {},
    sequence: 1,
    runId: "run-1",
    turnId: "turn-1",
    conversationId: "conv-1",
  };
  assert.equal(speechFromEvent(delta), undefined);
  const visible = speechFromEvent({ ...delta, eventId: "e2", type: "assistant.visible", payload: { visibleText: "shown" } });
  assert.equal(visible?.text, "shown");
  assert.equal(visible?.eventType, "assistant.visible");
  const finalSpeech = speechFromEvent({
    ...delta,
    eventId: "e3",
    type: "assistant.final",
    payload: { assistant: { visibleText: "done" } },
    data: {},
  });
  assert.equal(finalSpeech?.text, "done");
  assert.equal(speechFromEvent({ ...delta, type: "tool.request", payload: { text: "tool-text" } }), undefined);
});

test("unset stub URL stays off unless TEST_MODE is exactly 1; partial credentials throw", () => {
  assert.equal(liveDialogueMode({}), "off");
  assert.equal(liveDialogueMode({ [TEST_MODE_ENV]: "1" }), "sim");
  assert.equal(liveDialogueMode({ [LIVE_STUB_ENV]: "http://127.0.0.1:9" }), "off");
  assert.equal(liveDialogueMode({ [LIVE_STUB_ENV]: "http://127.0.0.1:9", [TEST_MODE_ENV]: "1" }), "sim");
  assert.equal(exchangeFromEnv({}), undefined);
  assert.throws(() => exchangeFromEnv({ [STUB_AUTHORIZATION_CODE_ENV]: "only-code" }), /together/);
  assert.throws(
    () =>
      liveDialogueMode({
        [LIVE_STUB_ENV]: "http://127.0.0.1:9",
        [STUB_SERVICE_USER_ENV]: SERVICE_USER,
        [STUB_SERVICE_PASSWORD_ENV]: SERVICE_PASSWORD,
      }),
    /must be set together/,
  );
});

test("exchange, grant read, conversation, turn, and SSE stay on the integrations prefix", async () => {
  const stub = await startStub();
  try {
    const env = envFor(stub.origin, {
      [STUB_AUTHORIZATION_CODE_ENV]: "code-1",
      [STUB_CODE_VERIFIER_ENV]: "verifier-1",
      [STUB_REDIRECT_URI_ENV]: "http://127.0.0.1/cb",
    });
    const input = liveTurnInputFromEnv(env, {
      deviceId: "ignored-device",
      digitalHumanId: "ignored-dh",
      text: "user-said-this",
      turnId: "turn-1",
      idempotencyKey: "idem-1",
    });
    const result = await runLiveTurn(input, { env });
    assert.equal(result.source, "openbot");
    assert.equal(result.conversationId, "conv-1");
    assert.equal(result.runId, "run-1");
    assert.equal(result.disposition, "accepted");
    assert.equal(result.agentSessionKey, "device-dh:dh-live:conv-1");
    assert.equal(result.gatewayAgentId, "agent-lab");
    assert.equal(result.cancelled, false);
    assert.deepEqual(
      result.speech.map((item) => item.text),
      ["visible-line", "final-line"],
    );
    assert.equal(result.speech.every((item) => item.source === "openbot"), true);
    assert.equal(result.speech.some((item) => item.text === "user-said-this" || item.text === "delta-secret"), false);
    assert.equal(result.events.some((event) => event.type === "assistant.delta"), true);
    assert.equal(result.toolRequests.length, 1);
    assert.equal(result.toolRequests[0]?.type, "tool.request");

    const exchange = stub.calls.find((call) => call.path.endsWith("/grants/exchange"));
    assert.equal(exchange?.authorization, BASIC);
    assert.equal(exchange?.grant, undefined);
    assert.equal(exchange?.idempotencyKey, "exchange-code-1");
    assert.deepEqual(exchange?.body, {
      authorizationCode: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "http://127.0.0.1/cb",
    });
    const after = stub.calls.filter((call) => !call.path.endsWith("/grants/exchange"));
    assert.equal(after.every((call) => call.authorization === BASIC), true);
    assert.equal(after.every((call) => call.grant === "grant-exchanged"), true);
    assert.equal(after.some((call) => call.grant === "grant-preset"), false);
    const turn = stub.calls.find((call) => call.path.endsWith("/turns"));
    assert.equal(turn?.idempotencyKey, "idem-1");
    const turnBody = turn?.body as { gatewayAgentId?: string; agentSessionKey?: string; text?: string; input?: { type?: string } };
    assert.equal(turnBody.gatewayAgentId, "agent-lab");
    assert.equal(turnBody.agentSessionKey, "device-dh:dh-live:conv-1");
    assert.equal(turnBody.text, "user-said-this");
    assert.equal(turnBody.input?.type, "text");
    assert.equal(stub.calls.every((call) => call.path.startsWith("/api/integrations/v1/")), true);
  } finally {
    await stub.close();
  }
});

test("a forced UI session key is sent only when the force flag is exactly 1", async () => {
  const stub = await startStub();
  try {
    const env = envFor(stub.origin, { [AGENT_SESSION_FORCE_ENV]: "1" });
    delete env[STUB_DEVICE_ID_ENV];
    const input = liveTurnInputFromEnv(env, {
      deviceId: IDENTITY.deviceId,
      digitalHumanId: IDENTITY.digitalHumanId,
      text: "hello",
      turnId: "turn-1",
      idempotencyKey: "idem-force",
    });
    const result = await runLiveTurn({ ...input, uiSessionKey: "ui-session" }, { env });
    assert.equal(result.agentSessionKey, "ui-session");
    const turn = stub.calls.find((call) => call.path.endsWith("/turns"));
    const turnBody = turn?.body as { agentSessionKey?: string };
    assert.equal(turnBody.agentSessionKey, "ui-session");
  } finally {
    await stub.close();
  }
});

test("the same turn key with a different body is IDEMPOTENCY_CONFLICT", async () => {
  const stub = await startStub();
  try {
    const env = envFor(stub.origin);
    const first = liveTurnInputFromEnv(env, {
      deviceId: IDENTITY.deviceId,
      digitalHumanId: IDENTITY.digitalHumanId,
      text: "same",
      turnId: "turn-1",
      idempotencyKey: "idem-conflict",
    });
    const accepted = await runLiveTurn(first, { env });
    assert.equal(accepted.disposition, "accepted");
    await assert.rejects(
      () => runLiveTurn({ ...first, text: "different" }, { env }),
      (error: unknown) => error instanceof LongitudinalError && error.status === 409 && error.errorCode === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await stub.close();
  }
});

test("barge-in cancels the held run and does not invent speech", async () => {
  const stub = await startStub({ holdEvents: true });
  try {
    const env = envFor(stub.origin);
    const input = liveTurnInputFromEnv(env, {
      deviceId: IDENTITY.deviceId,
      digitalHumanId: IDENTITY.digitalHumanId,
      text: "user-said-this",
      turnId: "turn-1",
      idempotencyKey: "idem-cancel",
    });
    const result = await runLiveTurn(input, {
      env,
      onRun: (run) => {
        void run.cancel();
      },
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.speech.length, 0);
    assert.equal(result.events.some((event) => event.type === "run.cancelled"), true);
    const cancel = stub.calls.find((call) => call.path.endsWith("/cancel"));
    assert.deepEqual(cancel?.body, { reason: "barge_in", turnId: "turn-1" });
    assert.equal(cancel?.grant, "grant-preset");
  } finally {
    await stub.close();
  }
});

test("consent PKCE S256 issues a code, and exchange returns the server authorizationRef", async () => {
  const stub = await startStub();
  try {
    const env = envFor(stub.origin, {
      [STUB_CONSENT_USER_ENV]: "consent-user",
      [STUB_CONSENT_PASSWORD_ENV]: "consent-secret",
      [STUB_SERVICE_AUDIENCE_ENV]: "svc-user",
      [STUB_SCOPES_ENV]: "device.talk, device.camera",
      [STUB_AUTH_STATE_ENV]: "state-1",
      [STUB_CODE_VERIFIER_ENV]: VERIFIER,
      [STUB_REDIRECT_URI_ENV]: "http://127.0.0.1/cb",
    });
    delete env[STUB_AUTHORIZATION_REF_ENV];
    delete env[STUB_GRANT_CREDENTIAL_ENV];
    delete env[STUB_BINDING_VERSION_ENV];
    const input = liveTurnInputFromEnv(env, {
      deviceId: IDENTITY.deviceId,
      digitalHumanId: IDENTITY.digitalHumanId,
      text: "from-asr",
      turnId: "turn-1",
      idempotencyKey: "idem-consent",
    });
    const result = await runLiveTurn(input, { env });
    assert.equal(result.source, "openbot");
    assert.equal(input.authorizationRef, undefined);
    const consent = stub.calls.find((call) => call.path.endsWith("/consent/authorization-codes"));
    assert.equal(consent?.grant, undefined);
    assert.equal(consent?.authorization, basicAuthorization("consent-user", "consent-secret"));
    assert.deepEqual(consent?.body, {
      serviceAudience: "svc-user",
      redirectUri: "http://127.0.0.1/cb",
      codeChallenge: codeChallengeS256(VERIFIER),
      codeChallengeMethod: "S256",
      digitalHumanId: IDENTITY.digitalHumanId,
      deviceId: IDENTITY.deviceId,
      scopes: ["device.talk", "device.camera"],
      state: "state-1",
    });
    assert.equal(JSON.stringify(consent?.body).includes("authorizationRef"), false);
    assert.equal(JSON.stringify(consent?.body).includes("pairChallenge"), false);
    const exchange = stub.calls.find((call) => call.path.endsWith("/grants/exchange"));
    assert.equal(exchange?.grant, undefined);
    assert.equal(exchange?.authorization, BASIC);
    const exchangeBody = exchange?.body as { authorizationCode?: string; codeVerifier?: string };
    assert.equal(exchangeBody.authorizationCode, "code-from-server");
    assert.equal(exchangeBody.codeVerifier, VERIFIER);
    const turn = stub.calls.find((call) => call.path.endsWith("/turns"));
    const turnBody = turn?.body as { authorizationRef?: string };
    assert.equal(turnBody.authorizationRef, "aref-from-server");
    assert.equal(turn?.grant, "grant-exchanged");
  } finally {
    await stub.close();
  }
});

test("rebind uses consent basic, revoke stays revoked, and an old bindingVersion is rejected", async () => {
  const stub = await startStub();
  try {
    const env = envFor(stub.origin, {
      [STUB_CONSENT_USER_ENV]: "consent-user",
      [STUB_CONSENT_PASSWORD_ENV]: "consent-secret",
    });
    const rebound = await rebindGrant(IDENTITY.authorizationRef, IDENTITY.digitalHumanId, { env });
    assert.equal(rebound.bindingVersion, IDENTITY.bindingVersion + 1);
    assert.equal(rebound.assistant.displayName, "Lab");
    assert.equal("voiceId" in rebound.assistant, false);
    const rebind = stub.calls.find((call) => call.path.endsWith("/rebind"));
    assert.equal(rebind?.authorization, basicAuthorization("consent-user", "consent-secret"));
    assert.equal(rebind?.grant, undefined);
    assert.deepEqual(rebind?.body, { digitalHumanId: IDENTITY.digitalHumanId });
    const first = await revokeGrant(IDENTITY.authorizationRef, { env });
    const second = await revokeGrant(IDENTITY.authorizationRef, { env });
    assert.equal(first.status, "revoked");
    assert.equal(second.status, "revoked");
    assert.equal(stub.calls.filter((call) => call.path.endsWith("/revoke")).length, 2);
    const input = liveTurnInputFromEnv(env, {
      deviceId: IDENTITY.deviceId,
      digitalHumanId: IDENTITY.digitalHumanId,
      text: "stale",
      turnId: "turn-1",
      idempotencyKey: "idem-stale",
    });
    await assert.rejects(
      () => runLiveTurn({ ...input, bindingVersion: 1 }, { env }),
      /old bindingVersion rejected/,
    );
    let posted = false;
    await assert.rejects(
      () =>
        submitToolResult(
          {
            requestId: "req-old",
            authorizationRef: IDENTITY.authorizationRef,
            bindingVersion: 1,
            currentBindingVersion: rebound.bindingVersion,
            status: "ok",
            idempotencyKey: "tool-old",
          },
          {
            env,
            fetchImpl: async () => {
              posted = true;
              return new Response("{}", { status: 500 });
            },
          },
        ),
      /old bindingVersion rejected/,
    );
    assert.equal(posted, false);
    const accepted = await submitToolResult(
      {
        requestId: "req-current",
        authorizationRef: IDENTITY.authorizationRef,
        bindingVersion: rebound.bindingVersion,
        currentBindingVersion: rebound.bindingVersion,
        status: "ok",
        idempotencyKey: "tool-current",
      },
      { env },
    );
    assert.equal(accepted.status, "ok");
    const events = await readDeviceEvents(IDENTITY.authorizationRef, { env });
    assert.deepEqual(events.map((event) => event.type), ["tool.request", "authorization.revoked"]);
  } finally {
    await stub.close();
  }
});

test("stub config is clients and digital humans only, with no pairing fields", () => {
  const parsed = parseStubConfig({
    clients: [
      {
        clientId: "consent-client",
        secret: "consent-secret-16",
        role: "consent",
        allowedDigitalHumanIds: ["dh-live"],
        scopes: ["device.talk"],
      },
      {
        clientId: "service-client",
        secret: "service-secret-16",
        role: "service",
        redirectUris: ["http://127.0.0.1/cb"],
      },
    ],
    digitalHumans: [
      {
        digitalHumanId: "dh-live",
        gatewayAgentId: "agent-lab",
        userSubject: "user-1",
        tenantId: "tenant-1",
        assistant: { digitalHumanId: "dh-live", displayName: "Lab", status: "active" },
      },
    ],
  });
  assert.equal(parsed.clients.length, 2);
  assert.equal(parsed.digitalHumans[0]?.gatewayAgentId, "agent-lab");
  assert.throws(() => parseStubConfig({ clients: [{ clientId: "c", secret: "short", role: "service", redirectUris: ["http://127.0.0.1/cb"] }], digitalHumans: [] }), /16/);
  assert.throws(
    () =>
      parseStubConfig({
        clients: [],
        digitalHumans: [],
        pairChallenge: "nope",
      }),
    /pairing fields/,
  );
});

test(
  "longitudinal turn against the configured stub",
  {
    skip:
      process.env[LIVE_STUB_ENV] &&
      process.env[STUB_SERVICE_USER_ENV] &&
      process.env[STUB_SERVICE_PASSWORD_ENV] &&
      process.env[STUB_AUTHORIZATION_REF_ENV] &&
      process.env[STUB_BINDING_VERSION_ENV] &&
      process.env[GATEWAY_AGENT_ID_ENV] &&
      (process.env[STUB_GRANT_CREDENTIAL_ENV] || process.env[STUB_AUTHORIZATION_CODE_ENV])
        ? false
        : "stub URL or longitudinal credentials are unset; a skip is not an end-to-end pass",
  },
  async () => {
    const input = liveTurnInputFromEnv(process.env, {
      deviceId: process.env[STUB_DEVICE_ID_ENV] ?? "dev-live",
      digitalHumanId: process.env[STUB_DIGITAL_HUMAN_ID_ENV] ?? "dh-live",
      text: "ping",
      turnId: `turn-live-${Date.now()}`,
      idempotencyKey: `live-${Date.now()}`,
    });
    const result = await runLiveTurn(input, { env: process.env });
    assert.equal(result.source, "openbot");
    assert.equal(result.conversationId.length > 0, true);
  },
);
