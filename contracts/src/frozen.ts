export const FROZEN_TOP_LEVEL_FIELDS = [
  "authorizationRef",
  "bindingVersion",
  "digitalHumanId",
  "deviceId",
] as const;

export type FrozenTopLevelField = (typeof FROZEN_TOP_LEVEL_FIELDS)[number];

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type AssistantFields = { readonly [key: string]: JsonValue };

export interface FrozenBinding {
  authorizationRef: string;
  bindingVersion: number;
  digitalHumanId: string;
  deviceId: string;
  assistant: AssistantFields;
}

const FROZEN_ALIASES = new Set([
  "authorization_ref",
  "authRef",
  "authorization",
  "binding_version",
  "bindingRev",
  "digital_human_id",
  "dhId",
  "digitalHuman",
  "device_id",
  "assistantProfile",
  "assistant_profile",
]);

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class FrozenFieldError extends Error {
  readonly code = "frozen_field";
  readonly field: string;

  constructor(field: string) {
    super(`frozen field rejected: ${field}`);
    this.name = "FrozenFieldError";
    this.field = field;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertNoFrozenAliases(input: object): void {
  for (const key of Object.keys(input)) {
    if (FROZEN_ALIASES.has(key) || FORBIDDEN_KEYS.has(key)) {
      throw new FrozenFieldError(key);
    }
  }
}

export function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new FrozenFieldError(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertJsonValue(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new FrozenFieldError(`${path}.${key}`);
      }
      if (child === undefined) {
        throw new FrozenFieldError(`${path}.${key}`);
      }
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new FrozenFieldError(path);
}

export function cloneAssistant(assistant: AssistantFields): AssistantFields {
  const cloned = structuredClone(assistant);
  assertJsonValue(cloned, "assistant");
  if (!isPlainObject(cloned)) {
    throw new FrozenFieldError("assistant");
  }
  return cloned;
}

export function assistantEqual(left: AssistantFields, right: AssistantFields): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertFrozenBinding(value: unknown): FrozenBinding {
  if (!isPlainObject(value)) {
    throw new FrozenFieldError("binding");
  }
  assertNoFrozenAliases(value);
  const { authorizationRef, bindingVersion, digitalHumanId, deviceId, assistant } = value;
  if (typeof authorizationRef !== "string" || authorizationRef.length === 0) {
    throw new FrozenFieldError("authorizationRef");
  }
  if (typeof bindingVersion !== "number" || !Number.isInteger(bindingVersion) || bindingVersion < 1) {
    throw new FrozenFieldError("bindingVersion");
  }
  if (typeof digitalHumanId !== "string" || digitalHumanId.length === 0) {
    throw new FrozenFieldError("digitalHumanId");
  }
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    throw new FrozenFieldError("deviceId");
  }
  assertJsonValue(assistant, "assistant");
  if (!isPlainObject(assistant)) {
    throw new FrozenFieldError("assistant");
  }
  return {
    authorizationRef,
    bindingVersion,
    digitalHumanId,
    deviceId,
    assistant: cloneAssistant(assistant),
  };
}
