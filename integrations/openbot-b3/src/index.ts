import { assertSessionId } from "../../../adapters/metalio/src/index.ts";
import { isPlainObject, standInApi, type AssistantFields } from "../../../contracts/src/index.ts";
import { invokeDeviceTool, type DeviceToolInput, type DeviceToolResult } from "../../../sdk/src/device-tools.ts";

export interface VisibleTtsResult {
  name: "assistant.tts";
  text: string;
  wire: string;
  visibleOnly: true;
}

export interface ToolInvocation {
  standIn: "B3";
  result: DeviceToolResult | VisibleTtsResult;
}

export interface B3ToolInput extends DeviceToolInput {
  assistant?: AssistantFields;
}

export interface IdempotencyRecord {
  deviceId: string | null;
  authorizationRef: string | null;
  bindingVersion: number | null;
  sessionId: string | null;
  digest: string;
  invocation: ToolInvocation;
}

export type ToolIdempotencyCache = Map<string, IdempotencyRecord>;

export interface B3Scope {
  deviceId: string;
  authorizationRef: string;
  bindingVersion: number;
  sessionId?: string;
}

export interface B3Plane {
  isRevoked(deviceId: string): boolean;
  getBinding(deviceId: string): { authorizationRef: string; bindingVersion: number; deviceId: string } | undefined;
}

export interface B3Options {
  /** Same key and same scoped request replays the first result. A different request conflicts. */
  idempotencyKey?: string;
  idempotency?: ToolIdempotencyCache;
  scope?: B3Scope;
  /** When set, revocation and the current binding are checked before a cache hit is returned. */
  plane?: B3Plane;
}

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";

  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class ToolAuthError extends Error {
  readonly code: "tool_revoked" | "tool_binding";

  constructor(code: "tool_revoked" | "tool_binding", message: string) {
    super(message);
    this.name = "ToolAuthError";
    this.code = code;
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

export class VisibleTtsError extends Error {
  readonly code = "assistant_visible_only";

  constructor(message: string) {
    super(message);
    this.name = "VisibleTtsError";
  }
}

/**
 * Speaks only `assistant.visible.speech`.
 * Other assistant keys, including anything outside `visible`, are not copied into the wire.
 */
export function speakVisibleAssistant(sessionId: string, assistant: AssistantFields): VisibleTtsResult {
  assertSessionId(sessionId);
  const text = visibleSpeech(assistant);
  const wire = JSON.stringify({
    session_id: sessionId,
    type: "tts",
    state: "sentence_start",
    text,
  });
  return { name: "assistant.tts", text, wire, visibleOnly: true };
}

/**
 * Consumer for stand-in B3 `POST /v1/device/tools:invoke`.
 * Delegates to the A3 device-tool catalog. Flash, mass flash, and reboot throw.
 * `assistant.tts` is a stand-in speech projection, not a firmware flash path.
 */
export function invokeOpenBotTool(name: string, input: B3ToolInput = {}, options: B3Options = {}): ToolInvocation {
  const api = standInApi("B3");
  if (api.path !== "/v1/device/tools:invoke") {
    throw new Error("openbot-b3 stand-in path drifted");
  }
  assertToolAuth(options);
  const cached = readIdempotent(name, input, options);
  if (cached) {
    return cached;
  }
  const invocation = execute(name, input);
  writeIdempotent(name, input, options, invocation);
  return invocation;
}

function execute(name: string, input: B3ToolInput): ToolInvocation {
  if (name === "assistant.tts") {
    if (input.sessionId === undefined || input.assistant === undefined) {
      throw new VisibleTtsError("assistant.tts requires sessionId and assistant");
    }
    return { standIn: "B3", result: speakVisibleAssistant(input.sessionId, input.assistant) };
  }
  return { standIn: "B3", result: invokeDeviceTool(name, input) };
}

function visibleSpeech(assistant: AssistantFields): string {
  const visible = assistant.visible;
  if (!isPlainObject(visible)) {
    throw new VisibleTtsError("assistant.visible.speech is required for TTS");
  }
  const speech = visible.speech;
  if (typeof speech !== "string" || speech.length === 0) {
    throw new VisibleTtsError("assistant.visible.speech is required for TTS");
  }
  return speech;
}

function assertToolAuth(options: B3Options): void {
  if (options.plane === undefined) {
    return;
  }
  if (options.scope === undefined) {
    throw new ToolAuthError("tool_binding", "tool scope is required when a control plane is attached");
  }
  if (options.plane.isRevoked(options.scope.deviceId)) {
    throw new ToolAuthError("tool_revoked", "device is revoked");
  }
  const binding = options.plane.getBinding(options.scope.deviceId);
  if (
    !binding ||
    binding.deviceId !== options.scope.deviceId ||
    binding.authorizationRef !== options.scope.authorizationRef ||
    binding.bindingVersion !== options.scope.bindingVersion
  ) {
    throw new ToolAuthError("tool_binding", "tool scope does not match the current binding");
  }
}

function readIdempotent(name: string, input: B3ToolInput, options: B3Options): ToolInvocation | undefined {
  const record = lookupRecord(options);
  if (record === undefined) {
    return undefined;
  }
  if (record.digest !== requestDigest(name, input, options)) {
    throw new IdempotencyConflictError("idempotency key was already used for a different request");
  }
  return structuredClone(record.invocation);
}

function writeIdempotent(name: string, input: B3ToolInput, options: B3Options, invocation: ToolInvocation): void {
  if (options.idempotencyKey === undefined) {
    return;
  }
  const cache = requireCache(options.idempotencyKey, options.idempotency);
  const scope = resolvedScope(input, options);
  cache.set(options.idempotencyKey, {
    deviceId: scope.deviceId,
    authorizationRef: scope.authorizationRef,
    bindingVersion: scope.bindingVersion,
    sessionId: scope.sessionId,
    digest: requestDigest(name, input, options),
    invocation: structuredClone(invocation),
  });
}

function lookupRecord(options: B3Options): IdempotencyRecord | undefined {
  if (options.idempotencyKey === undefined) {
    return undefined;
  }
  const found = requireCache(options.idempotencyKey, options.idempotency).get(options.idempotencyKey);
  return found === undefined ? undefined : found;
}

function requireCache(key: string, cache: ToolIdempotencyCache | undefined): ToolIdempotencyCache {
  assertKey(key);
  if (cache === undefined) {
    throw new Error("openbot-b3 idempotencyKey requires an idempotency cache");
  }
  return cache;
}

function resolvedScope(
  input: B3ToolInput,
  options: B3Options,
): { deviceId: string | null; authorizationRef: string | null; bindingVersion: number | null; sessionId: string | null } {
  return {
    deviceId: options.scope?.deviceId ?? null,
    authorizationRef: options.scope?.authorizationRef ?? null,
    bindingVersion: options.scope?.bindingVersion ?? null,
    sessionId: options.scope?.sessionId ?? input.sessionId ?? null,
  };
}

function requestDigest(name: string, input: B3ToolInput, options: B3Options): string {
  const scope = resolvedScope(input, options);
  return JSON.stringify(stable({ name, input, ...scope }));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stable(item));
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) {
        sorted[key] = stable(item);
      }
    }
    return sorted;
  }
  return value;
}

function assertKey(key: string): void {
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new Error("idempotency key must match [A-Za-z0-9_.:-]{1,128}");
  }
}
