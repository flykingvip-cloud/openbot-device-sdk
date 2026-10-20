import { standInApi } from "../../../contracts/src/index.ts";
import { invokeDeviceTool, type DeviceToolInput, type DeviceToolResult } from "../../../sdk/src/device-tools.ts";

export interface ToolInvocation {
  standIn: "B3";
  result: DeviceToolResult;
}

/**
 * Consumer for stand-in B3 `POST /v1/device/tools:invoke`.
 * Delegates to the A3 device-tool catalog. Flash, mass flash, and reboot throw.
 */
export function invokeOpenBotTool(name: string, input: DeviceToolInput = {}): ToolInvocation {
  const api = standInApi("B3");
  if (api.path !== "/v1/device/tools:invoke") {
    throw new Error("openbot-b3 stand-in path drifted");
  }
  return { standIn: "B3", result: invokeDeviceTool(name, input) };
}
