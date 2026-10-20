import { createHash } from "node:crypto";

import {
  DEVICE_EVENT_TYPES,
  EVENT_ENVELOPE_TYPES,
  GATEWAY_AGENT_ID_ENV,
  GRANT_CREDENTIAL_HEADER,
  INTEGRATIONS_API_PREFIX,
  STUB_AUTHORIZATION_CODE_ENV,
  STUB_AUTHORIZATION_REF_ENV,
  STUB_AUTH_STATE_ENV,
  STUB_BINDING_VERSION_ENV,
  STUB_CODE_VERIFIER_ENV,
  STUB_CONSENT_PASSWORD_ENV,
  STUB_CONSENT_USER_ENV,
  STUB_DEVICE_ID_ENV,
  STUB_DIGITAL_HUMAN_ID_ENV,
  STUB_GRANT_CREDENTIAL_ENV,
  STUB_REDIRECT_URI_ENV,
  STUB_SCOPES_ENV,
  STUB_SERVICE_AUDIENCE_ENV,
  TEST_MODE_ENV,
  consentBasicFromEnv,
  gatewayAgentIdFromEnv,
  resolveAgentSession,
  serviceBasicFromEnv,
  stubLocationFromEnv,
} from "../../../contracts/src/index.ts";

const ENVELOPE_TYPES = new Set<string>(EVENT_ENVELOPE_TYPES);
const DEVICE_EVENTS = new Set<string>(DEVICE_EVENT_TYPES);
const PAIRING_FIELDS = new Set(["pairChallenge", "pairingChallenge", "pairingCode", "ownershipProof", "pairNonce"]);
const ASSISTANT_OPTIONAL = ["avatar", "animationManifestUrl", "locale", "voiceHint", "visibleText", "messageId"] as const;

export class LongitudinalError extends Error {
  readonly status: number;
  readonly errorCode: string | undefined;

  constructor(status: number, message: string, errorCode?: string) {
    super(message);
    this.name = "LongitudinalError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

export interface RunEvent {
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
  data: Record<string, unknown>;
  sequence: number | undefined;
  runId: string | undefined;
  turnId: string | undefined;
  conversationId: string | undefined;
}

export interface AssistantSpeech {
  source: "openbot";
  eventType: "assistant.visible" | "assistant.final";
  eventId: string;
  text: string;
}

export interface OpenBotAssistant {
  digitalHumanId: string;
  displayName: string;
  status: "active" | "disabled";
  avatar?: string;
  animationManifestUrl?: string;
  locale?: string;
  voiceHint?: string;
  visibleText?: string;
  messageId?: string;
}

export interface GrantView {
  authorizationRef: string;
  bindingVersion: number;
  digitalHumanId: string;
  deviceId: string;
  status: string | undefined;
  assistant: OpenBotAssistant;
}

export interface RevokeView {
  authorizationRef: string;
  bindingVersion: number;
  digitalHumanId: string;
  deviceId: string;
  status: "revoked";
}

export interface ExchangeResult extends GrantView {
  authorizationCredential: string;
  disposition: string | undefined;
}

export interface LiveTurnResult {
  source: "openbot";
  conversationId: string;
  runId: string;
  turnId: string | undefined;
  disposition: string;
  agentSessionKey: string;
  gatewayAgentId: string;
  events: RunEvent[];
  speech: AssistantSpeech[];
  toolRequests: RunEvent[];
  cancelled: boolean;
}

export interface ExchangeInput {
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string;
  idempotencyKey: string;
}

export interface AuthorizationCodeInput {
  serviceAudience: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  digitalHumanId: string;
  deviceId: string;
  scopes: string[];
  state: string;
}

export interface AuthorizationCodeResult {
  authorizationCode: string;
  state: string;
  digitalHumanId: string;
  deviceId: string;
  expiresAt: string | undefined;
}

export interface ConsentCodeInput {
  serviceAudience: string;
  redirectUri: string;
  codeVerifier: string;
  digitalHumanId: string;
  deviceId: string;
  scopes: string[];
  state: string;
  idempotencyKey: string;
}

export interface ToolResultInput {
  requestId: string;
  authorizationRef: string;
  bindingVersion: number;
  currentBindingVersion: number;
  status: "ok" | "failed" | "unknown" | "cancelled" | "busy" | "timeout" | "denied" | "unsupported";
  idempotencyKey: string;
  runId?: string;
  errorCode?: string | null;
  result?: Record<string, unknown> | null;
}

export interface LiveTurnInput {
  authorizationRef?: string;
  bindingVersion?: number;
  digitalHumanId: string;
  deviceId: string;
  text: string;
  turnId: string;
  idempotencyKey: string;
  gatewayAgentId: string;
  uiSessionKey?: string;
  exchange?: ExchangeInput;
  consent?: ConsentCodeInput;
}

export interface LiveRunHandle {
  runId: string;
  turnId: string | undefined;
  cancel: () => Promise<CancelResult>;
}

export interface CancelResult {
  runId: string | undefined;
  accepted: boolean | undefined;
  status: string | undefined;
  sideEffectsRolledBack: boolean | undefined;
  reason: string | undefined;
}

export interface LiveTurnOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  onRun?: (run: LiveRunHandle) => void;
  onSpeech?: (speech: AssistantSpeech) => void;
  onEvent?: (event: RunEvent) => void;
}

/**
 * Live dialogue needs the loopback stub plus service Basic, and either the grant
 * credential, a complete exchange trio, or a complete consent request.
 * Local sim speech runs only when `OPENBOT_DEVICE_DH_TEST_MODE=1`.
 * Otherwise the connector stays off and does not invent assistant speech.
 */
export function liveDialogueMode(env: NodeJS.ProcessEnv): "sim" | "live" | "off" {
  if (stubLocationFromEnv(env) !== undefined) {
    const service = serviceBasicFromEnv(env);
    const grant = env[STUB_GRANT_CREDENTIAL_ENV];
    const grantSet = grant !== undefined && grant.length > 0;
    const exchangeReady = exchangeFromEnv(env) !== undefined;
    const consentReady = consentRequestReady(env);
    if (service === undefined && !grantSet && !exchangeReady && !consentReady) {
      return testModeEnabled(env) ? "sim" : "off";
    }
    if (service === undefined || (!grantSet && !exchangeReady && !consentReady)) {
      throw new Error("service basic and X-OpenBot-Grant-Credential must be set together");
    }
    return "live";
  }
  return testModeEnabled(env) ? "sim" : "off";
}

export function testModeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[TEST_MODE_ENV] === "1";
}

/** PKCE S256 challenge. The connector never sends a method other than S256. */
export function codeChallengeS256(verifier: string): string {
  if (verifier.length < 43 || verifier.length > 128) {
    throw new Error("PKCE code verifier must be 43 to 128 characters");
  }
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Presented version must equal the grant's current version.
 * A smaller version is an old binding and is rejected before any turn or tool result.
 */
export function assertBindingVersion(current: number, presented: number): void {
  if (!Number.isInteger(presented) || presented < 1 || !Number.isInteger(current) || current < 1) {
    throw new Error("bindingVersion is invalid");
  }
  if (presented < current) {
    throw new Error("old bindingVersion rejected");
  }
  if (presented !== current) {
    throw new Error("bindingVersion does not match the grant");
  }
}

/** Text the device may speak. User ASR text is never a fallback. */
export function speechFromEvent(event: RunEvent): AssistantSpeech | undefined {
  const eventType = event.type;
  if (eventType !== "assistant.visible" && eventType !== "assistant.final") {
    return undefined;
  }
  const text = firstText(
    readString(event.payload, "text"),
    readString(event.payload, "visibleText"),
    readString(asRecord(event.payload.assistant), "visibleText"),
    readString(asRecord(event.payload.assistant), "text"),
    readString(event.data, "text"),
    readString(event.data, "visibleText"),
    readString(asRecord(event.data.assistant), "visibleText"),
  );
  if (text === undefined) {
    return undefined;
  }
  return { source: "openbot", eventType, eventId: event.eventId, text };
}

export function parseSseBlock(block: string): RunEvent | undefined {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(dataLines.join("\n"));
  return asRunEvent(parsed);
}

export async function exchangeGrant(input: ExchangeInput, options: LiveTurnOptions): Promise<ExchangeResult> {
  const location = requireLocation(options.env);
  const service = serviceBasicFromEnv(options.env);
  if (service === undefined) {
    throw new Error("grant exchange requires service basic");
  }
  const body = await sendJson(options.fetchImpl ?? fetch, `${location.integrationsBase}/grants/exchange`, "POST", {
    Authorization: service.authorization,
    "Idempotency-Key": input.idempotencyKey,
  }, {
    authorizationCode: input.authorizationCode,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
  });
  const grant = asGrant(body);
  const credential = readString(body, "authorizationCredential");
  if (credential === undefined) {
    throw new Error("grant exchange did not return authorizationCredential");
  }
  return {
    ...grant,
    authorizationCredential: credential,
    disposition: readString(body, "disposition"),
  };
}

export async function readGrant(
  authorizationRef: string,
  options: LiveTurnOptions,
  grantCredential?: string,
): Promise<GrantView> {
  const headers = grantHeaders(options.env, grantCredential);
  const location = requireLocation(options.env);
  const body = await sendJson(
    options.fetchImpl ?? fetch,
    `${location.integrationsBase}/grants/${encodeURIComponent(authorizationRef)}`,
    "GET",
    headers,
  );
  return asGrant(body);
}

/** Consent Basic only. Body fields match AuthorizationCodeRequest. No authorizationRef is sent. */
export async function requestAuthorizationCode(
  input: AuthorizationCodeInput,
  options: LiveTurnOptions,
): Promise<AuthorizationCodeResult> {
  if (input.codeChallengeMethod !== "S256") {
    throw new Error("codeChallengeMethod must be S256");
  }
  const consent = consentBasicFromEnv(options.env);
  if (consent === undefined) {
    throw new Error("authorization code request requires consent basic");
  }
  const body = {
    serviceAudience: input.serviceAudience,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256" as const,
    digitalHumanId: input.digitalHumanId,
    deviceId: input.deviceId,
    scopes: input.scopes,
    state: input.state,
  };
  assertNoPairingFields(body);
  const response = await sendJson(
    options.fetchImpl ?? fetch,
    `${requireLocation(options.env).integrationsBase}/consent/authorization-codes`,
    "POST",
    { Authorization: consent.authorization },
    body,
  );
  const authorizationCode = readString(response, "authorizationCode");
  const state = readString(response, "state");
  const digitalHumanId = readString(response, "digitalHumanId");
  const deviceId = readString(response, "deviceId");
  if (authorizationCode === undefined || state === undefined || digitalHumanId === undefined || deviceId === undefined) {
    throw new Error("authorization code response is missing authorizationCode, state, digitalHumanId, or deviceId");
  }
  if (state !== input.state || digitalHumanId !== input.digitalHumanId || deviceId !== input.deviceId) {
    throw new Error("authorization code response does not match the consent request");
  }
  return {
    authorizationCode,
    state,
    digitalHumanId,
    deviceId,
    expiresAt: readString(response, "expiresAt"),
  };
}

/** Consent Basic only. Body is `{ digitalHumanId }`. The returned bindingVersion replaces the old one. */
export async function rebindGrant(
  authorizationRef: string,
  digitalHumanId: string,
  options: LiveTurnOptions,
): Promise<GrantView> {
  const consent = consentBasicFromEnv(options.env);
  if (consent === undefined) {
    throw new Error("rebind requires consent basic");
  }
  const body = { digitalHumanId };
  assertNoPairingFields(body);
  const response = await sendJson(
    options.fetchImpl ?? fetch,
    `${requireLocation(options.env).integrationsBase}/grants/${encodeURIComponent(authorizationRef)}/rebind`,
    "POST",
    { Authorization: consent.authorization },
    body,
  );
  return asGrant(response);
}

/** Service Basic plus the grant credential. A second call stays revoked. */
export async function revokeGrant(
  authorizationRef: string,
  options: LiveTurnOptions,
  grantCredential?: string,
): Promise<RevokeView> {
  const response = await sendJson(
    options.fetchImpl ?? fetch,
    `${requireLocation(options.env).integrationsBase}/grants/${encodeURIComponent(authorizationRef)}/revoke`,
    "POST",
    grantHeaders(options.env, grantCredential),
  );
  const identity = asIdentity(response);
  if (identity.status !== "revoked") {
    throw new Error("revoke did not stay revoked");
  }
  return {
    authorizationRef: identity.authorizationRef,
    bindingVersion: identity.bindingVersion,
    digitalHumanId: identity.digitalHumanId,
    deviceId: identity.deviceId,
    status: "revoked",
  };
}

/** Device command SSE: tool.request, authorization.revoked, binding.updated, run.cancelled. */
export async function readDeviceEvents(
  authorizationRef: string,
  options: LiveTurnOptions,
  grantCredential?: string,
): Promise<RunEvent[]> {
  const headers = grantHeaders(options.env, grantCredential);
  const response = await (options.fetchImpl ?? fetch)(
    `${requireLocation(options.env).integrationsBase}/grants/${encodeURIComponent(authorizationRef)}/device-events`,
    { method: "GET", headers: { ...headers, accept: "text/event-stream" } },
  );
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw await errorFrom(response);
  }
  const events: RunEvent[] = [];
  await readSse(response.body, (event) => {
    if (!DEVICE_EVENTS.has(event.type)) {
      throw new Error(`device event type is not a device SSE name: ${event.type}`);
    }
    events.push(event);
  });
  return events;
}

/** Posts a tool result. An older bindingVersion is rejected locally and is not sent. */
export async function submitToolResult(
  input: ToolResultInput,
  options: LiveTurnOptions,
  grantCredential?: string,
): Promise<Record<string, unknown>> {
  assertBindingVersion(input.currentBindingVersion, input.bindingVersion);
  const body: Record<string, unknown> = {
    requestId: input.requestId,
    authorizationRef: input.authorizationRef,
    bindingVersion: input.bindingVersion,
    status: input.status,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.result === undefined ? {} : { result: input.result }),
  };
  assertNoPairingFields(body);
  return sendJson(
    options.fetchImpl ?? fetch,
    `${requireLocation(options.env).integrationsBase}/device-tool-requests/${encodeURIComponent(input.requestId)}/result`,
    "POST",
    { ...grantHeaders(options.env, grantCredential), "Idempotency-Key": input.idempotencyKey },
    body,
  );
}

/**
 * Read or exchange the grant, open a conversation, post one turn, and read run SSE.
 * authorizationRef comes from the exchange response when consent or exchange runs.
 * Spoken text comes only from assistant.visible and assistant.final.
 */
export async function runLiveTurn(input: LiveTurnInput, options: LiveTurnOptions): Promise<LiveTurnResult> {
  if (liveDialogueMode(options.env) !== "live" && input.exchange === undefined && input.consent === undefined) {
    throw new Error("live turn requires OPENBOT_DEVICE_DH_STUB_URL, service basic, and the grant credential");
  }
  if (input.consent !== undefined && input.exchange !== undefined) {
    throw new Error("authorization code and consent request must not both be set");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const location = requireLocation(options.env);
  let grantCredential = options.env[STUB_GRANT_CREDENTIAL_ENV];
  let authorizationRef = input.authorizationRef;
  if (input.consent !== undefined) {
    const issued = await requestAuthorizationCode(
      {
        serviceAudience: input.consent.serviceAudience,
        redirectUri: input.consent.redirectUri,
        codeChallenge: codeChallengeS256(input.consent.codeVerifier),
        codeChallengeMethod: "S256",
        digitalHumanId: input.consent.digitalHumanId,
        deviceId: input.consent.deviceId,
        scopes: input.consent.scopes,
        state: input.consent.state,
      },
      options,
    );
    const exchanged = await exchangeGrant(
      {
        authorizationCode: issued.authorizationCode,
        codeVerifier: input.consent.codeVerifier,
        redirectUri: input.consent.redirectUri,
        idempotencyKey: input.consent.idempotencyKey,
      },
      options,
    );
    grantCredential = exchanged.authorizationCredential;
    authorizationRef = adoptAuthorizationRef(authorizationRef, exchanged.authorizationRef);
    if (input.bindingVersion !== undefined) {
      assertBindingVersion(exchanged.bindingVersion, input.bindingVersion);
    }
  } else if (input.exchange !== undefined) {
    const exchanged = await exchangeGrant(input.exchange, options);
    grantCredential = exchanged.authorizationCredential;
    authorizationRef = adoptAuthorizationRef(authorizationRef, exchanged.authorizationRef);
    if (input.bindingVersion !== undefined) {
      assertBindingVersion(exchanged.bindingVersion, input.bindingVersion);
    }
  }
  if (authorizationRef === undefined) {
    throw new Error("authorizationRef comes from grant exchange and is not invented locally");
  }
  const grant = await readGrant(authorizationRef, options, grantCredential);
  if (input.bindingVersion !== undefined) {
    assertBindingVersion(grant.bindingVersion, input.bindingVersion);
  }
  if (grant.deviceId !== input.deviceId || grant.digitalHumanId !== input.digitalHumanId) {
    throw new Error("grant does not match the device binding");
  }
  if (grant.assistant.digitalHumanId !== grant.digitalHumanId) {
    throw new Error("grant assistant does not match digitalHumanId");
  }
  const headers = grantHeaders(options.env, grantCredential);
  const created = await sendJson(fetchImpl, `${location.integrationsBase}/conversations`, "POST", headers, {
    authorizationRef: grant.authorizationRef,
    bindingVersion: grant.bindingVersion,
    deviceId: grant.deviceId,
  });
  const conversationId = readString(created, "conversationId");
  if (conversationId === undefined) {
    throw new Error("conversation response is missing conversationId");
  }
  const session = resolveAgentSession({
    digitalHumanId: grant.digitalHumanId,
    conversationId,
    gatewayAgentId: input.gatewayAgentId,
    env: options.env,
    ...(input.uiSessionKey === undefined ? {} : { uiSessionKey: input.uiSessionKey }),
  });
  const accepted = await sendJson(
    fetchImpl,
    `${location.integrationsBase}/conversations/${encodeURIComponent(conversationId)}/turns`,
    "POST",
    { ...headers, "Idempotency-Key": input.idempotencyKey },
    {
      turnId: input.turnId,
      text: input.text,
      authorizationRef: grant.authorizationRef,
      bindingVersion: grant.bindingVersion,
      deviceId: grant.deviceId,
      idempotencyKey: input.idempotencyKey,
      input: { type: "text", text: input.text },
      gatewayAgentId: session.gatewayAgentId,
      agentSessionKey: session.sessionKey,
    },
  );
  const runId = readString(accepted, "runId");
  const disposition = readString(accepted, "disposition");
  if (runId === undefined || disposition === undefined) {
    throw new Error("turn response is missing runId or disposition");
  }
  const turnId = readString(accepted, "turnId") ?? input.turnId;
  let didCancel = false;
  let pendingCancel: Promise<CancelResult> | undefined;
  const cancel = (): Promise<CancelResult> => {
    didCancel = true;
    if (pendingCancel === undefined) {
      pendingCancel = sendJson(
        fetchImpl,
        `${location.integrationsBase}/runs/${encodeURIComponent(runId)}/cancel`,
        "POST",
        headers,
        { reason: "barge_in", turnId },
      ).then((body) => asCancel(body, runId));
    }
    return pendingCancel;
  };
  const response = await fetchImpl(`${location.integrationsBase}/runs/${encodeURIComponent(runId)}/events`, {
    method: "GET",
    headers: { ...headers, accept: "text/event-stream" },
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw await errorFrom(response);
  }
  options.onRun?.({ runId, turnId, cancel });
  const events: RunEvent[] = [];
  const speech: AssistantSpeech[] = [];
  const toolRequests: RunEvent[] = [];
  await readSse(response.body, (event) => {
    events.push(event);
    options.onEvent?.(event);
    if (event.type === "tool.request") {
      toolRequests.push(event);
    }
    const spoken = speechFromEvent(event);
    if (spoken !== undefined) {
      speech.push(spoken);
      options.onSpeech?.(spoken);
    }
  });
  return {
    source: "openbot",
    conversationId,
    runId,
    turnId,
    disposition,
    agentSessionKey: session.sessionKey,
    gatewayAgentId: session.gatewayAgentId,
    events,
    speech,
    toolRequests,
    cancelled: didCancel,
  };
}

/** Fields the lab voice live path reads. Missing gateway or grant identity is an error, not sim speech. */
export function liveTurnInputFromEnv(
  env: NodeJS.ProcessEnv,
  fallback: { deviceId: string; digitalHumanId: string; text: string; turnId: string; idempotencyKey: string },
): LiveTurnInput {
  const authorizationRef = env[STUB_AUTHORIZATION_REF_ENV];
  const deviceId = env[STUB_DEVICE_ID_ENV] ?? fallback.deviceId;
  const digitalHumanId = env[STUB_DIGITAL_HUMAN_ID_ENV] ?? fallback.digitalHumanId;
  const versionRaw = env[STUB_BINDING_VERSION_ENV];
  const gatewayAgentId = gatewayAgentIdFromEnv(env);
  const exchange = exchangeFromEnv(env);
  const consent = consentRequestFromEnv(env, { deviceId, digitalHumanId });
  if (exchange !== undefined && consent !== undefined) {
    throw new Error("authorization code and consent request must not both be set");
  }
  const refSet = authorizationRef !== undefined && authorizationRef.length > 0;
  if (!refSet && exchange === undefined && consent === undefined) {
    throw new Error(`${STUB_AUTHORIZATION_REF_ENV} is required unless consent or exchange supplies it`);
  }
  let bindingVersion: number | undefined;
  if (versionRaw !== undefined && versionRaw.length > 0) {
    if (!/^[0-9]+$/.test(versionRaw)) {
      throw new Error(`${STUB_BINDING_VERSION_ENV} must be an integer`);
    }
    bindingVersion = Number(versionRaw);
  } else if (exchange === undefined && consent === undefined) {
    throw new Error(`${STUB_BINDING_VERSION_ENV} must be an integer`);
  }
  if (gatewayAgentId === null) {
    throw new Error(`${GATEWAY_AGENT_ID_ENV} is required for a live turn`);
  }
  return {
    ...(refSet && authorizationRef !== undefined ? { authorizationRef } : {}),
    ...(bindingVersion === undefined ? {} : { bindingVersion }),
    digitalHumanId,
    deviceId,
    text: fallback.text,
    turnId: fallback.turnId,
    idempotencyKey: fallback.idempotencyKey,
    gatewayAgentId,
    ...(exchange === undefined ? {} : { exchange }),
    ...(consent === undefined ? {} : { consent }),
  };
}

export function exchangeFromEnv(env: NodeJS.ProcessEnv): ExchangeInput | undefined {
  const authorizationCode = env[STUB_AUTHORIZATION_CODE_ENV];
  const codeVerifier = env[STUB_CODE_VERIFIER_ENV];
  const redirectUri = env[STUB_REDIRECT_URI_ENV];
  if (authorizationCode === undefined || authorizationCode.length === 0) {
    return undefined;
  }
  if (
    codeVerifier === undefined ||
    redirectUri === undefined ||
    codeVerifier.length === 0 ||
    redirectUri.length === 0
  ) {
    throw new Error("authorization code, code verifier, and redirect URI must be set together");
  }
  return {
    authorizationCode,
    codeVerifier,
    redirectUri,
    idempotencyKey: `exchange-${authorizationCode}`,
  };
}

function requireLocation(env: NodeJS.ProcessEnv) {
  const location = stubLocationFromEnv(env);
  if (location === undefined) {
    throw new Error("OPENBOT_DEVICE_DH_STUB_URL is unset");
  }
  return location;
}

function grantHeaders(env: NodeJS.ProcessEnv, grantCredential: string | undefined): Record<string, string> {
  const service = serviceBasicFromEnv(env);
  const fromEnv = env[STUB_GRANT_CREDENTIAL_ENV];
  const credential =
    grantCredential !== undefined && grantCredential.length > 0 ? grantCredential : fromEnv;
  if (service === undefined || credential === undefined || credential.length === 0) {
    throw new Error("service basic and X-OpenBot-Grant-Credential must be set together");
  }
  return {
    Authorization: service.authorization,
    [GRANT_CREDENTIAL_HEADER]: credential,
  };
}

async function sendJson(
  fetchImpl: typeof fetch,
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...headers,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(assertOutbound(body)) }),
  });
  if (!response.ok) {
    throw await errorFrom(response);
  }
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${method} ${pathOf(url)} returned a non-object`);
  }
  return parsed as Record<string, unknown>;
}

async function errorFrom(response: Response): Promise<LongitudinalError> {
  const text = await response.text();
  let errorCode: string | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const error = asRecord(asRecord(parsed)?.error);
    const code = error === undefined ? undefined : readString(error, "code");
    errorCode = code;
  } catch {
    errorCode = undefined;
  }
  const suffix = errorCode === undefined ? "" : ` ${errorCode}`;
  return new LongitudinalError(response.status, `${pathOf(response.url)} failed: ${response.status}${suffix}`, errorCode);
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith(INTEGRATIONS_API_PREFIX) ? parsed.pathname : url;
  } catch {
    return url;
  }
}

async function readSse(stream: ReadableStream<Uint8Array>, onEvent: (event: RunEvent) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const event = parseSseBlock(part);
        if (event !== undefined) {
          onEvent(event);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const event = parseSseBlock(buffer);
      if (event !== undefined) {
        onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function asGrant(body: Record<string, unknown>): GrantView {
  const identity = asIdentity(body);
  const assistant = asAssistant(body.assistant);
  if (assistant.digitalHumanId !== identity.digitalHumanId) {
    throw new Error("grant assistant does not match digitalHumanId");
  }
  return { ...identity, assistant };
}

function asIdentity(body: Record<string, unknown>): {
  authorizationRef: string;
  bindingVersion: number;
  digitalHumanId: string;
  deviceId: string;
  status: string | undefined;
} {
  const authorizationRef = readString(body, "authorizationRef");
  const digitalHumanId = readString(body, "digitalHumanId");
  const deviceId = readString(body, "deviceId");
  const bindingVersion = body.bindingVersion;
  if (
    authorizationRef === undefined ||
    digitalHumanId === undefined ||
    deviceId === undefined ||
    typeof bindingVersion !== "number" ||
    !Number.isInteger(bindingVersion) ||
    bindingVersion < 1
  ) {
    throw new Error("grant is missing authorizationRef, bindingVersion, digitalHumanId, or deviceId");
  }
  return {
    authorizationRef,
    bindingVersion,
    digitalHumanId,
    deviceId,
    status: readString(body, "status"),
  };
}

function asAssistant(value: unknown): OpenBotAssistant {
  const record = asRecord(value);
  if (record === undefined) {
    throw new Error("grant assistant is missing");
  }
  assertNoPairingFields(record);
  for (const alias of ["assistantProfile", "assistant_profile", "voice_id"]) {
    if (alias in record) {
      throw new Error("grant assistant uses a renamed field");
    }
  }
  const digitalHumanId = readString(record, "digitalHumanId");
  const displayName = readString(record, "displayName");
  const status = readString(record, "status");
  if (digitalHumanId === undefined || displayName === undefined || (status !== "active" && status !== "disabled")) {
    throw new Error("grant assistant is missing digitalHumanId, displayName, or status");
  }
  const assistant: OpenBotAssistant = { digitalHumanId, displayName, status };
  for (const key of ASSISTANT_OPTIONAL) {
    const text = readString(record, key);
    if (text !== undefined) {
      assistant[key] = text;
    }
  }
  return assistant;
}

function adoptAuthorizationRef(configured: string | undefined, issued: string): string {
  if (configured !== undefined && configured !== issued) {
    throw new Error("grant exchange returned a different authorizationRef");
  }
  return issued;
}

function assertOutbound(body: unknown): unknown {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    assertNoPairingFields(body as Record<string, unknown>);
  }
  return body;
}

function assertNoPairingFields(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (PAIRING_FIELDS.has(key)) {
      throw new Error("pairing fields are device-platform state and are not OpenBot contract fields");
    }
  }
}

function consentRequestReady(env: NodeJS.ProcessEnv): boolean {
  try {
    return consentRequestFromEnv(env, { deviceId: "device", digitalHumanId: "dh" }) !== undefined;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must not both be set")) {
      return true;
    }
    throw error;
  }
}

function consentRequestFromEnv(
  env: NodeJS.ProcessEnv,
  fallback: { deviceId: string; digitalHumanId: string },
): ConsentCodeInput | undefined {
  const audience = env[STUB_SERVICE_AUDIENCE_ENV];
  const scopesRaw = env[STUB_SCOPES_ENV];
  const state = env[STUB_AUTH_STATE_ENV];
  const any = [audience, scopesRaw, state].some((value) => value !== undefined && value.length > 0);
  if (!any) {
    return undefined;
  }
  const consent = consentBasicFromEnv(env);
  if (
    consent === undefined ||
    audience === undefined ||
    scopesRaw === undefined ||
    state === undefined ||
    audience.length === 0 ||
    scopesRaw.length === 0 ||
    state.length === 0
  ) {
    throw new Error("consent client, service audience, scopes, and state must be set together");
  }
  const verifier = env[STUB_CODE_VERIFIER_ENV];
  const redirectUri = env[STUB_REDIRECT_URI_ENV];
  if (verifier === undefined || redirectUri === undefined || verifier.length === 0 || redirectUri.length === 0) {
    throw new Error("PKCE verifier and redirect URI are required for consent");
  }
  if (env[STUB_AUTHORIZATION_CODE_ENV] !== undefined && env[STUB_AUTHORIZATION_CODE_ENV].length > 0) {
    throw new Error("authorization code and consent request must not both be set");
  }
  const deviceId = env[STUB_DEVICE_ID_ENV] ?? fallback.deviceId;
  const digitalHumanId = env[STUB_DIGITAL_HUMAN_ID_ENV] ?? fallback.digitalHumanId;
  if (deviceId.length === 0 || digitalHumanId.length === 0) {
    throw new Error("deviceId and digitalHumanId are required for consent");
  }
  const scopes = scopesRaw.split(",").map((scope) => scope.trim()).filter((scope) => scope.length > 0);
  if (scopes.length === 0) {
    throw new Error("scopes must be a comma-separated list");
  }
  return {
    serviceAudience: audience,
    redirectUri,
    codeVerifier: verifier,
    digitalHumanId,
    deviceId,
    scopes,
    state,
    idempotencyKey: `exchange-${state}`,
  };
}

function asCancel(body: Record<string, unknown>, runId: string): CancelResult {
  return {
    runId: readString(body, "runId") ?? runId,
    accepted: typeof body.accepted === "boolean" ? body.accepted : undefined,
    status: readString(body, "status"),
    sideEffectsRolledBack: typeof body.sideEffectsRolledBack === "boolean" ? body.sideEffectsRolledBack : undefined,
    reason: readString(body, "reason"),
  };
}

function asRunEvent(value: unknown): RunEvent {
  const record = asRecord(value);
  if (record === undefined) {
    throw new Error("SSE data is not an object");
  }
  const type = readString(record, "type");
  const eventId = readString(record, "eventId");
  if (type === undefined || eventId === undefined) {
    throw new Error("SSE event is missing type or eventId");
  }
  if (!ENVELOPE_TYPES.has(type)) {
    throw new Error(`SSE event type is not in the OpenAPI enum: ${type}`);
  }
  const sequence = record.sequence;
  return {
    eventId,
    type,
    payload: asRecord(record.payload) ?? {},
    data: asRecord(record.data) ?? {},
    sequence: typeof sequence === "number" ? sequence : undefined,
    runId: readString(record, "runId"),
    turnId: readString(record, "turnId"),
    conversationId: readString(record, "conversationId"),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
