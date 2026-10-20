import { OPENBOT_CONTRACT_SHA } from "./pin.ts";

/** Prefix for every capability route. `GET /healthz` stays on the stub root. */
export const INTEGRATIONS_API_PREFIX = "/api/integrations/v1";

/** OpenAPI `servers.url` reported for the loopback stub. Not a public host. */
export const STUB_SERVER_URL = "http://127.0.0.1:8787/api/integrations/v1";

export const STUB_ROOT_HEALTH_PATH = "/healthz";

export const DIGITAL_HUMAN_PROFILE_PATH = `${INTEGRATIONS_API_PREFIX}/digital-humans/{digitalHumanId}`;

export const OPENAPI_SOURCE_URL =
  `https://raw.githubusercontent.com/flykingvip-cloud/openbot-vp/${OPENBOT_CONTRACT_SHA}/docs/integrations/device-digital-human/openapi.yaml`;

/** Bytes of `contracts/openbot/device-digital-human.openapi.yaml` are the pin tree. */
export const OPENAPI_FETCH = {
  sha: OPENBOT_CONTRACT_SHA,
  url: OPENAPI_SOURCE_URL,
  httpStatus: 200,
  vendored: true,
  routesAligned: true,
} as const;

/**
 * Not route mismatches. The vendored paths match; these handlers are still absent.
 * Empty when nothing further is listed. Route mismatches belong in `alignmentGaps`.
 */
export const IMPLEMENTATION_GAPS = [
  "B0 and B2-B5 stand-in handlers remain when the live connector is off. Local sim speech requires OPENBOT_DEVICE_DH_TEST_MODE=1. Those handlers do not serve the vendored grants, conversations, runs, or media routes",
  "The connector can call consent, exchange, rebind, revoke, conversations, turns, run SSE, device events, and tool results on a loopback stub. This repository does not emit those events. routesAligned is static OpenAPI alignment, not an end-to-end pass",
  "Device-platform pair challenge and the OpenBot UI device-control API are not OpenBot contract fields. There is no client registry HTTP API; stub config is clients[] and digitalHumans[] only",
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
    idempotencyKey: true,
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
    path: `${INTEGRATIONS_API_PREFIX}/conversations/{conversationId}`,
    underIntegrationsPrefix: true,
  },
  {
    group: "conversations",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/conversations/{conversationId}/close`,
    underIntegrationsPrefix: true,
  },
  {
    group: "conversations",
    method: "POST",
    path: `${INTEGRATIONS_API_PREFIX}/conversations/{conversationId}/turns`,
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

/** EventEnvelope.type order in the vendored OpenAPI. */
export const EVENT_ENVELOPE_TYPES = [
  ...RUN_EVENT_TYPES,
  "authorization.revoked",
  "binding.updated",
] as const;

export interface OpenApiAlignment {
  aligned: boolean;
  gaps: string[];
}

/** Compares consumer routes and SSE enums with a vendored OpenAPI document. */
export function alignConsumerRoutes(openapiYaml: string): OpenApiAlignment {
  const paths = openapiPaths(openapiYaml);
  const events = openapiEventEnvelopeTypes(openapiYaml);
  const gaps: string[] = [];
  const consumerPaths = CONSUMER_ROUTES.filter((route) => route.underIntegrationsPrefix).map((route) =>
    route.path.slice(INTEGRATIONS_API_PREFIX.length),
  );
  if (paths.length !== consumerPaths.length) {
    gaps.push(`path count ${consumerPaths.length} != OpenAPI ${paths.length}`);
  }
  const consumerSet = new Set(consumerPaths);
  const openSet = new Set(paths);
  for (const path of paths) {
    if (!consumerSet.has(path)) {
      gaps.push(`OpenAPI path missing from consumer mirror: ${path}`);
    }
  }
  for (const path of consumerPaths) {
    if (!openSet.has(path)) {
      gaps.push(`consumer path missing from OpenAPI: ${path}`);
    }
  }
  if (events.length !== EVENT_ENVELOPE_TYPES.length || events.some((event, index) => event !== EVENT_ENVELOPE_TYPES[index])) {
    gaps.push("EventEnvelope type enum does not match RUN and device SSE names");
  }
  for (const event of DEVICE_EVENT_TYPES) {
    if (!events.includes(event)) {
      gaps.push(`device SSE type missing from OpenAPI: ${event}`);
    }
  }
  for (const event of RUN_EVENT_TYPES) {
    if (!events.includes(event)) {
      gaps.push(`run SSE type missing from OpenAPI: ${event}`);
    }
  }
  return { aligned: gaps.length === 0, gaps };
}

function openapiPaths(yaml: string): string[] {
  const paths: string[] = [];
  let inPaths = false;
  for (const line of yaml.split("\n")) {
    if (line === "paths:") {
      inPaths = true;
      continue;
    }
    if (!inPaths) {
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ")) {
      break;
    }
    const match = /^  (\/[^:]+):$/.exec(line);
    if (match?.[1] !== undefined) {
      paths.push(match[1]);
    }
  }
  return paths;
}

function openapiEventEnvelopeTypes(yaml: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === "    EventEnvelope:");
  if (start < 0) {
    return [];
  }
  const enumAt = lines.slice(start).findIndex((line) => line === "          enum:");
  if (enumAt < 0) {
    return [];
  }
  const events: string[] = [];
  for (const line of lines.slice(start + enumAt + 1)) {
    const match = /^            - (.+)$/.exec(line);
    if (!match?.[1]) {
      break;
    }
    events.push(match[1]);
  }
  return events;
}

export function digitalHumanProfileUrl(baseUrl: string, digitalHumanId: string): string {
  const path = DIGITAL_HUMAN_PROFILE_PATH.replace("{digitalHumanId}", encodeURIComponent(digitalHumanId));
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}
