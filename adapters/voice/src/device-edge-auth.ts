/**
 * Device → SDK edge → OpenBot service auth sketch (docs + minimal types).
 *
 * Two-hop (firmware MUST NOT burn platform Basic):
 * 1. Device presents **per-device** credentials to the SDK edge
 *    (lab: claim/redeem short-lived connection token from control plane;
 *    product: device identity / mTLS / etc. — out of this package).
 * 2. SDK edge holds **service** Basic + grant credential and attaches
 *    `Authorization: Basic …`, `X-OpenBot-Grant-Credential`, `X-Device-Id`
 *    when calling OpenBot (stub :8787 / integrations). Firmware never sees
 *    serviceClientId:secret.
 *
 * This file is an interface-only sketch. It does not mint grants, does not
 * replace ControlPlane, and does not change device-control OpenAPI.
 */

/** Per-device proof presented to the SDK edge (not service Basic). */
export interface DeviceEdgeDeviceCredential {
  deviceId: string;
  /** Lab connection token or future device assertion. */
  deviceToken: string;
}

/** Secrets the edge keeps; never shipped in firmware images. */
export interface DeviceEdgeServiceCredential {
  /** HTTP Basic for integrations service client. */
  authorization: string;
  /** Value for X-OpenBot-Grant-Credential. */
  grantCredential: string;
}

export const DEVICE_EDGE_DEVICE_ID_HEADER = "X-Device-Id";
export const DEVICE_EDGE_GRANT_HEADER = "X-OpenBot-Grant-Credential";

/**
 * Headers the edge attaches toward OpenBot after verifying the device hop.
 * deviceId on the wire must equal grant.deviceId (BINDING_MISMATCH otherwise).
 */
export function buildOpenBotServiceHeaders(
  service: DeviceEdgeServiceCredential,
  deviceId: string,
): Record<string, string> {
  return {
    Authorization: service.authorization,
    [DEVICE_EDGE_GRANT_HEADER]: service.grantCredential,
    [DEVICE_EDGE_DEVICE_ID_HEADER]: deviceId,
  };
}

/**
 * Optional loopback proxy sketch: verify device hop, then forward with service headers.
 * Implementations live outside this package (or P1). Control plane is unchanged.
 */
export interface DeviceEdgeAuthProxy {
  /**
   * Verify device credential / token for deviceId.
   * Returns false → caller should 401 without contacting OpenBot.
   */
  verifyDevice(credential: DeviceEdgeDeviceCredential): Promise<boolean> | boolean;
  /** Service headers for a verified deviceId. */
  openBotHeaders(deviceId: string): Record<string, string>;
}
