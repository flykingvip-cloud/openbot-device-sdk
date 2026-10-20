import { OPENBOT_CONTRACT_SHA } from "./pin.ts";

/** Prefix for every capability route. `GET /healthz` stays on the stub root. */
export const INTEGRATIONS_API_PREFIX = "/api/integrations/v1";

/** OpenAPI `servers.url` reported for the loopback stub. Not a public host. */
export const STUB_SERVER_URL = "http://127.0.0.1:8787/api/integrations/v1";

export const STUB_ROOT_HEALTH_PATH = "/healthz";

export const DIGITAL_HUMAN_PROFILE_PATH = `${INTEGRATIONS_API_PREFIX}/digital-humans/{digitalHumanId}`;

export const OPENAPI_SOURCE_URL =
  `https://raw.githubusercontent.com/flykingvip-cloud/openbot-vp/${OPENBOT_CONTRACT_SHA}/docs/integrations/device-digital-human/openapi.yaml`;

/**
 * The raw file was requested and returned HTTP 404. Consumer paths below are
 * transcribed from Agent B's message, not from vendored OpenAPI bytes.
 * `routesAligned` stays false until those bytes are in-tree and match.
 */
export const OPENAPI_FETCH = {
  sha: OPENBOT_CONTRACT_SHA,
  url: OPENAPI_SOURCE_URL,
  httpStatus: 404,
  vendored: false,
  routesAligned: false,
} as const;

export const ALIGNMENT_GAPS = [
  "openapi.yaml bytes were not vendored because the pin tree returned HTTP 404",
  "B1 live GET uses /api/integrations/v1/digital-humans/{digitalHumanId}; local reads still use the control plane",
  "B0 and B2–B5 stand-in paths remain lab mocks and are not the grants, conversations, runs, or media routes",
  "run and device SSE event names are transcribed only; no run pipeline emits them",
] as const;

export interface ConsumerRoute {
  group: "health" | "grants" | "conversations" | "device-media";
  method: "GET" | "POST" | "PUT";
  path: string;
  sse?: true;
  idempotencyKey?: true;
  /** False only for stub-root `GET /healthz`. */
  underIntegrationsPrefix: boolean;
}

export const CONSUMER_ROUTES = [
  {
    group: "health",
    method: "GET",
    path: STUB_ROOT_HEALTH_PATH,
    underIntegrationsPrefix: false,
  },
  {
    group: "grants",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/consent/authorization-codes`,
    underIntegrationsPrefix: true,
  },
  {
    group: "grants",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/grants/exchange`,
    underIntegrationsPrefix: true,
  },
  {
    group: "grants",
    method: "GET",
    path: `${INTEGRATIONS_API_PREFIX}/grants/{authorizationRef}`,
    underIntegrationsPrefix: true,
  },
  {
    group: "grants",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/grants/{authorizationRef}/revoke`,
    underIntegrationsPrefix: true,
  },
  {
    group: "grants",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/grants/{authorizationRef}/rebind`,
    underIntegrationsPrefix: true,
  },
  {
    group: "grants",
    method: "PUT",
    path: `${INTEGRATIONS_API_PREFIX}/grants/{authorizationRef}/device-capabilities`,
    underIntegrationsPrefix: true,
  },
  {
    group: "grants",
    method: "GET",
    path: `${INTEGRATIONS_API_PREFIX}/grants/{authorizationRef}/device-events`,
    sse: true,
    underIntegrationsPrefix: true,
  },
  {
    group: "grants",
    method: "GET",
    path: DIGITAL_HUMAN_PROFILE_PATH,
    underIntegrationsPrefix: true,
  },
  {
    group: "conversations",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/conversations`,
    underIntegrationsPrefix: true,
  },
  {
    group: "conversations",
    method: "GET",
    path: `${INTEGRATIONS_API_PREFIX}/conversations/{id}`,
    underIntegrationsPrefix: true,
  },
  {
    group: "conversations",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/conversations/{id}/close`,
    underIntegrationsPrefix: true,
  },
  {
    group: "conversations",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/conversations/{id}/turns`,
    idempotencyKey: true,
    underIntegrationsPrefix: true,
  },
  {
    group: "conversations",
    method: "GET",
    path: `${INTEGRATIONS_API_PREFIX}/runs/{runId}`,
    underIntegrationsPrefix: true,
  },
  {
    group: "conversations",
    method: "GET",
    path: `${INTEGRATIONS_API_PREFIX}/runs/{runId}/events`,
    sse: true,
    underIntegrationsPrefix: true,
  },
  {
    group: "conversations",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/runs/{runId}/cancel`,
    underIntegrationsPrefix: true,
  },
  {
    group: "device-media",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/device-tool-requests/{requestId}/result`,
    idempotencyKey: true,
    underIntegrationsPrefix: true,
  },
  {
    group: "device-media",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/media/upload-tickets`,
    underIntegrationsPrefix: true,
  },
  {
    group: "device-media",
    method: "PUT",
    path: `${INTEGRATIONS_API_PREFIX}/media/uploads/{ticket}`,
    underIntegrationsPrefix: true,
  },
] as const satisfies readonly ConsumerRoute[];

export const RUN_EVENT_TYPES = [
  "run.accepted",
  "run.started",
  "assistant.delta",
  "assistant.visible",
  "assistant.final",
  "approval.required",
  "tool.request",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;

export const DEVICE_EVENT_TYPES = [
  "tool.request",
  "authorization.revoked",
  "binding.updated",
  "run.cancelled",
] as const;

export function digitalHumanProfileUrl(baseUrl: string, digitalHumanId: string): string {
  const path = DIGITAL_HUMAN_PROFILE_PATH.replace("{digitalHumanId}", encodeURIComponent(digitalHumanId));
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}
