/** Lab or stub config supplies this. It is not a rename of a frozen field. */
export const GATEWAY_AGENT_ID_ENV = "OPENBOT_DEVICE_DH_GATEWAY_AGENT_ID";

/**
 * UI session keys are ignored unless this variable is exactly `1`.
 * Any other value, including unset, keeps the default device-dh key.
 */
export const AGENT_SESSION_FORCE_ENV = "OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE";

export interface AgentSession {
  gatewayAgentId: string;
  sessionKey: string;
  forced: boolean;
}

export function gatewayAgentIdFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env[GATEWAY_AGENT_ID_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }
  if (raw !== raw.trim() || raw.includes(":")) {
    throw new Error("gatewayAgentId must not contain whitespace or ':'");
  }
  return raw;
}

export function agentSessionForceEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[AGENT_SESSION_FORCE_ENV] === "1";
}

/** Default agent session. Not the local B2 `sessionId`. */
export function deviceAgentSessionKey(digitalHumanId: string, conversationId: string): string {
  assertSessionPart(digitalHumanId, "digitalHumanId");
  assertSessionPart(conversationId, "conversationId");
  return `device-dh:${digitalHumanId}:${conversationId}`;
}

/**
 * Uses `device-dh:<digitalHumanId>:<conversationId>` unless
 * `OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE=1` and a UI session key is present.
 */
export function resolveAgentSession(input: {
  digitalHumanId: string;
  conversationId: string;
  gatewayAgentId: string;
  uiSessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentSession {
  if (input.gatewayAgentId.trim().length === 0 || input.gatewayAgentId.includes(":")) {
    throw new Error("gatewayAgentId is required");
  }
  const env = input.env ?? {};
  const ui = input.uiSessionKey;
  if (agentSessionForceEnabled(env) && ui !== undefined && ui.length > 0) {
    return { gatewayAgentId: input.gatewayAgentId, sessionKey: ui, forced: true };
  }
  return {
    gatewayAgentId: input.gatewayAgentId,
    sessionKey: deviceAgentSessionKey(input.digitalHumanId, input.conversationId),
    forced: false,
  };
}

function assertSessionPart(value: string, name: string): void {
  if (value.length === 0 || value.includes(":")) {
    throw new Error(`${name} is required and must not contain ':'`);
  }
}
