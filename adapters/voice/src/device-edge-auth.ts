/**
 * Device → SDK edge → OpenBot service auth (lab-runnable two-hop).
 *
 * Two-hop (firmware MUST NOT burn platform Basic):
 * 1. Device presents **per-device** credentials to the SDK edge
 *    (lab: claim/redeem short-lived connection token from control plane;
 *    product: device identity / mTLS / etc. — out of this package).
 * 2. SDK edge holds **service** Basic + grant credential and attaches
 *    `Authorization: Basic …`, `X-OpenBot-Grant-Credential`, `X-Device-Id`
 *    when calling OpenBot (stub :8787 / integrations). Firmware never sees
 *    serviceClientId / secret.
 *
 * This module provides types, header builders, and a lab `LabDeviceEdgeAuthProxy`.
 * It does not mint grants, does not replace ControlPlane, and does not change
 * device-control OpenAPI.
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
 * Lab / product edge: verify device hop, then expose OpenBot service headers.
 * Control plane is unchanged; grant minting is out of scope.
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

/** Result of authorizing the device hop before any OpenBot contact. */
export type DeviceEdgeAuthorizeResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; status: 401; error: "device_unauthorized" };

export type DeviceEdgeVerifyFn = (
  credential: DeviceEdgeDeviceCredential,
) => boolean | Promise<boolean>;

export interface LabDeviceEdgeAuthProxyOptions {
  service: DeviceEdgeServiceCredential;
  verifyDevice: DeviceEdgeVerifyFn;
}

/**
 * Runnable lab implementation of {@link DeviceEdgeAuthProxy}.
 * Holds service secrets on the edge only; never returns them to the device.
 */
export class LabDeviceEdgeAuthProxy implements DeviceEdgeAuthProxy {
  private readonly service: DeviceEdgeServiceCredential;
  private readonly verify: DeviceEdgeVerifyFn;

  constructor(options: LabDeviceEdgeAuthProxyOptions) {
    this.service = options.service;
    this.verify = options.verifyDevice;
  }

  verifyDevice(credential: DeviceEdgeDeviceCredential): Promise<boolean> | boolean {
    return this.verify(credential);
  }

  openBotHeaders(deviceId: string): Record<string, string> {
    return buildOpenBotServiceHeaders(this.service, deviceId);
  }

  /**
   * Verify the device hop. On failure returns 401 and **must not** be followed
   * by any OpenBot / upstream call. On success returns the three service headers.
   */
  async authorize(credential: DeviceEdgeDeviceCredential): Promise<DeviceEdgeAuthorizeResult> {
    const ok = await this.verifyDevice(credential);
    if (!ok) {
      return { ok: false, status: 401, error: "device_unauthorized" };
    }
    return { ok: true, headers: this.openBotHeaders(credential.deviceId) };
  }
}

/**
 * In-memory deviceId → deviceToken map for lab / unit smoke.
 * Not a control-plane replacement; production should wire claim/redeem tokens.
 */
export function createTokenMapDeviceVerifier(
  tokens: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): DeviceEdgeVerifyFn {
  const map =
    tokens instanceof Map ? tokens : new Map(Object.entries(tokens));
  return (credential) => {
    const expected = map.get(credential.deviceId);
    return expected !== undefined && expected === credential.deviceToken && expected.length > 0;
  };
}

/**
 * Wire a ControlPlane-like assessor without importing services (avoids cycles).
 * Pass `(deviceId, token) => plane.assessConnectionCredential(deviceId, token).ok`.
 */
export function createAssessingDeviceVerifier(
  assessOk: (deviceId: string, deviceToken: string) => boolean | Promise<boolean>,
): DeviceEdgeVerifyFn {
  return (credential) => assessOk(credential.deviceId, credential.deviceToken);
}
