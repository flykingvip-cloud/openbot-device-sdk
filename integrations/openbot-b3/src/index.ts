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

export type ToolIdempotencyCache = Map<string, ToolInvocation>;

export interface B3Options {
  /** Replays the first invocation and ignores a later payload, including a swapped assistant. */
  idempotencyKey?: string;
  idempotency?: ToolIdempotencyCache;
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
  const cached = readIdempotent(options);
  if (cached) {
    return cached;
  }
  const invocation = execute(name, input);
  writeIdempotent(options, invocation);
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

function readIdempotent(options: B3Options): ToolInvocation | undefined {
  if (options.idempotencyKey === undefined) {
    return undefined;
  }
  assertKey(options.idempotencyKey);
  if (options.idempotency === undefined) {
    throw new Error("openbot-b3 idempotencyKey requires an idempotency cache");
  }
  const found = options.idempotency.get(options.idempotencyKey);
  return found === undefined ? undefined : structuredClone(found);
}

function writeIdempotent(options: B3Options, invocation: ToolInvocation): void {
  if (options.idempotencyKey === undefined) {
    return;
  }
  if (options.idempotency === undefined) {
    throw new Error("openbot-b3 idempotencyKey requires an idempotency cache");
  }
  options.idempotency.set(options.idempotencyKey, structuredClone(invocation));
}

function assertKey(key: string): void {
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new Error("idempotency key must match [A-Za-z0-9_.:-]{1,128}");
  }
}
