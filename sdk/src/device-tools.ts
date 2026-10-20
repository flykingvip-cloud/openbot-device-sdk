import {
  buildAbortMessage,
  buildListenMessage,
  buildMcpMessage,
  type AbortReason,
  type ListeningMode,
} from "../../adapters/metalio/src/index.ts";
import { chatEmotionPath, emotionCategory, mediaCapabilities, type EmotionCategory } from "./media.ts";

export type DeviceToolName =
  | "voice.abort"
  | "voice.listen.start"
  | "voice.listen.stop"
  | "voice.wakeWord"
  | "mcp.forward"
  | "media.describe"
  | "emotion.map";

export interface DeviceToolSpec {
  name: DeviceToolName;
  direction: "uplink" | "local";
  executable: true;
}

export const DEVICE_TOOLS: readonly DeviceToolSpec[] = [
  { name: "voice.abort", direction: "uplink", executable: true },
  { name: "voice.listen.start", direction: "uplink", executable: true },
  { name: "voice.listen.stop", direction: "uplink", executable: true },
  { name: "voice.wakeWord", direction: "uplink", executable: true },
  { name: "mcp.forward", direction: "uplink", executable: true },
  { name: "media.describe", direction: "local", executable: true },
  { name: "emotion.map", direction: "local", executable: true },
];

/** Known firmware commands this control plane must not send. */
export const DISABLED_DEVICE_COMMANDS = ["ota.flash", "ota.massFlash", "system.reboot"] as const;

export type DisabledDeviceCommand = (typeof DISABLED_DEVICE_COMMANDS)[number];

export class DeviceToolError extends Error {
  readonly code: "unknown_tool" | "disabled_command";

  constructor(code: "unknown_tool" | "disabled_command", message: string) {
    super(message);
    this.name = "DeviceToolError";
    this.code = code;
  }
}

export type DeviceToolResult =
  | { name: "voice.abort"; wire: string }
  | { name: "voice.listen.start"; wire: string }
  | { name: "voice.listen.stop"; wire: string }
  | { name: "voice.wakeWord"; wire: string }
  | { name: "mcp.forward"; wire: string }
  | { name: "media.describe"; capabilities: ReturnType<typeof mediaCapabilities> }
  | { name: "emotion.map"; category: EmotionCategory; chatPath: string };

export interface DeviceToolInput {
  sessionId?: string;
  reason?: AbortReason;
  mode?: ListeningMode;
  text?: string;
  payload?: Record<string, unknown>;
  emotion?: string;
}

function requireSession(input: DeviceToolInput): string {
  if (input.sessionId === undefined || input.sessionId.length === 0) {
    throw new DeviceToolError("unknown_tool", "sessionId is required for uplink tools");
  }
  return input.sessionId;
}

export function invokeDeviceTool(name: string, input: DeviceToolInput = {}): DeviceToolResult {
  if ((DISABLED_DEVICE_COMMANDS as readonly string[]).includes(name)) {
    throw new DeviceToolError("disabled_command", `${name} is not executable; production OTA, mass flash, and remote reboot are disabled`);
  }
  switch (name) {
    case "voice.abort":
      return { name, wire: buildAbortMessage(requireSession(input), input.reason) };
    case "voice.listen.start":
      return {
        name,
        wire: buildListenMessage(requireSession(input), "start", input.mode === undefined ? {} : { mode: input.mode }),
      };
    case "voice.listen.stop":
      return { name, wire: buildListenMessage(requireSession(input), "stop") };
    case "voice.wakeWord":
      return {
        name,
        wire: buildListenMessage(requireSession(input), "detect", { text: input.text ?? "Hi" }),
      };
    case "mcp.forward":
      return { name, wire: buildMcpMessage(requireSession(input), input.payload ?? {}) };
    case "media.describe":
      return { name, capabilities: mediaCapabilities() };
    case "emotion.map":
      return {
        name,
        category: emotionCategory(input.emotion),
        chatPath: chatEmotionPath(input.emotion),
      };
    default:
      throw new DeviceToolError("unknown_tool", `unknown device tool: ${name}`);
  }
}

/**
 * Firmware downlink shape for `type=system,command=reboot`.
 * Returned for documentation. This SDK never schedules `Reboot()`.
 */
export function describeSystemRebootCommand(): { type: "system"; command: "reboot"; executable: false } {
  return { type: "system", command: "reboot", executable: false };
}
