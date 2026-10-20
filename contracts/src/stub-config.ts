/**
 * Shape of the loopback stub's config file. There is no client-registry HTTP API.
 * Pairing and device ownership stay on the device platform and are not fields here.
 */

export interface StubConsentClient {
  clientId: string;
  secret: string;
  role: "consent";
  allowedDigitalHumanIds: string[];
  scopes: string[];
}

export interface StubServiceClient {
  clientId: string;
  secret: string;
  role: "service";
  redirectUris: string[];
}

export type StubClientDraft = StubConsentClient | StubServiceClient;

export interface StubAssistantDraft {
  digitalHumanId: string;
  displayName: string;
  status: "active" | "disabled";
}

export interface StubDigitalHumanDraft {
  digitalHumanId: string;
  gatewayAgentId: string;
  userSubject: string;
  tenantId: string;
  assistant: StubAssistantDraft;
}

export interface StubConfigDraft {
  clients: StubClientDraft[];
  digitalHumans: StubDigitalHumanDraft[];
}

const PAIRING_FIELDS = new Set(["pairChallenge", "pairingChallenge", "pairingCode", "ownershipProof", "pairNonce"]);

export function parseStubConfig(value: unknown): StubConfigDraft {
  const record = asRecord(value);
  if (record === undefined) {
    throw new Error("stub config must be an object with clients and digitalHumans");
  }
  rejectPairingFields(record);
  if (!Array.isArray(record.clients) || !Array.isArray(record.digitalHumans)) {
    throw new Error("stub config requires clients[] and digitalHumans[]");
  }
  return {
    clients: record.clients.map((client) => parseClient(client)),
    digitalHumans: record.digitalHumans.map((human) => parseDigitalHuman(human)),
  };
}

function parseClient(value: unknown): StubClientDraft {
  const record = asRecord(value);
  if (record === undefined) {
    throw new Error("stub client must be an object");
  }
  rejectPairingFields(record);
  const clientId = requiredString(record, "clientId");
  const secret = requiredString(record, "secret");
  if (secret.length < 16) {
    throw new Error("stub client secret must be at least 16 characters");
  }
  const role = requiredString(record, "role");
  if (role === "consent") {
    return {
      clientId,
      secret,
      role,
      allowedDigitalHumanIds: requiredStringList(record, "allowedDigitalHumanIds"),
      scopes: requiredStringList(record, "scopes"),
    };
  }
  if (role === "service") {
    return {
      clientId,
      secret,
      role,
      redirectUris: requiredStringList(record, "redirectUris"),
    };
  }
  throw new Error("stub client role must be consent or service");
}

function parseDigitalHuman(value: unknown): StubDigitalHumanDraft {
  const record = asRecord(value);
  if (record === undefined) {
    throw new Error("stub digital human must be an object");
  }
  rejectPairingFields(record);
  const digitalHumanId = requiredString(record, "digitalHumanId");
  const assistant = asRecord(record.assistant);
  if (assistant === undefined) {
    throw new Error("stub digital human assistant is required");
  }
  rejectPairingFields(assistant);
  const status = requiredString(assistant, "status");
  if (status !== "active" && status !== "disabled") {
    throw new Error("stub assistant status must be active or disabled");
  }
  const assistantId = requiredString(assistant, "digitalHumanId");
  if (assistantId !== digitalHumanId) {
    throw new Error("stub assistant digitalHumanId must match the digital human");
  }
  return {
    digitalHumanId,
    gatewayAgentId: requiredString(record, "gatewayAgentId"),
    userSubject: requiredString(record, "userSubject"),
    tenantId: requiredString(record, "tenantId"),
    assistant: {
      digitalHumanId: assistantId,
      displayName: requiredString(assistant, "displayName"),
      status,
    },
  };
}

function requiredStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`stub config ${key} must be a non-empty string list`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`stub config ${key} is required`);
  }
  return value;
}

function rejectPairingFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (PAIRING_FIELDS.has(key)) {
      throw new Error("pairing fields are device-platform state, not stub config");
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
