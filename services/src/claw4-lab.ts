import { ControlPlane } from "./control-plane.ts";
import { ControlPlaneError } from "./errors.ts";

const DEFAULT_DH = "dh-claw4-lab";
const DEFAULT_ASSISTANT = { voiceId: "voice-lab" };

export interface EnsureLabDeviceBoundResult {
  created: boolean;
  authorizationRef: string;
  bindingVersion: number;
}

/**
 * Lab bind for MetalioClaw4 LAN bring-up: claim → redeem → bind on a shared ControlPlane.
 * Not the production OpenBot grant path.
 */
export function ensureLabDeviceBound(
  plane: ControlPlane,
  deviceId: string,
  options: { digitalHumanId?: string; assistant?: { voiceId: string } } = {},
): EnsureLabDeviceBoundResult {
  const digitalHumanId = options.digitalHumanId ?? DEFAULT_DH;
  const assistant = options.assistant ?? DEFAULT_ASSISTANT;
  try {
    const credential = plane.issueConnectionCredential(deviceId);
    return {
      created: false,
      authorizationRef: credential.authorizationRef,
      bindingVersion: credential.bindingVersion,
    };
  } catch (error) {
    if (!(error instanceof ControlPlaneError)) {
      throw error;
    }
  }
  const ticket = plane.issueClaim(deviceId);
  plane.redeemClaim(deviceId, ticket.code);
  const binding = plane.bind({ deviceId, digitalHumanId, assistant });
  return {
    created: true,
    authorizationRef: binding.authorizationRef,
    bindingVersion: binding.bindingVersion,
  };
}
