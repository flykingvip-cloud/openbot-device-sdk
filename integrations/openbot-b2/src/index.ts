import { assertNoFrozenAliases, standInApi, type FrozenBinding } from "../../../contracts/src/index.ts";
import type { ControlPlane } from "../../../services/src/index.ts";

export interface SessionRequest {
  authorizationRef: string;
  bindingVersion: number;
  digitalHumanId: string;
  deviceId: string;
}

export interface DeviceSession {
  sessionId: string;
  binding: FrozenBinding;
  standIn: "B2";
}

export interface B2Options {
  plane: ControlPlane;
  sessionId?: () => string;
}

let sessionCounter = 0;

/**
 * Consumer for stand-in B2 `POST /v1/device/sessions`.
 * Opens a session only when the frozen fields match the current binding.
 */
export function openDeviceSession(request: SessionRequest, options: B2Options): DeviceSession {
  assertNoFrozenAliases(request);
  const api = standInApi("B2");
  if (api.method !== "POST") {
    throw new Error("openbot-b2 stand-in method drifted");
  }
  const binding = options.plane.getBinding(request.deviceId);
  if (!binding) {
    throw new Error("device is not bound");
  }
  if (
    binding.authorizationRef !== request.authorizationRef ||
    binding.bindingVersion !== request.bindingVersion ||
    binding.digitalHumanId !== request.digitalHumanId ||
    binding.deviceId !== request.deviceId
  ) {
    throw new Error("session request does not match the frozen binding");
  }
  sessionCounter += 1;
  const sessionId = options.sessionId?.() ?? `sess_${sessionCounter}`;
  return { sessionId, binding, standIn: "B2" };
}
