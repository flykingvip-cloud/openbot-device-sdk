import {
  CONTRACT_PIN,
  INTEGRATIONS_API_PREFIX,
  LIVE_STUB_ENV,
  OPENBOT_CONTRACT_SHA,
  STUB_AUTHORIZATION_REF_ENV,
  STUB_BINDING_VERSION_ENV,
  STUB_DEVICE_ID_ENV,
  STUB_DIGITAL_HUMAN_ID_ENV,
  serviceGrantHeaders,
  stubLocationFromEnv,
  type StubLocation,
} from "../../../contracts/src/index.ts";
import { readDigitalHuman } from "../../openbot-b1/src/index.ts";
import { LabCameraSession, runLabCameraCapture, type CameraToolRequest } from "../../openbot-media/src/index.ts";
import { ControlPlane } from "../../../services/src/index.ts";

export interface SkippedCall {
  state: "skipped";
  reason: string;
}

export interface LiveProfileHit {
  state: "ok";
  digitalHumanId: string;
}

export interface LiveCameraHit {
  state: "ok";
  contentType: string;
  width: number;
  height: number;
  checksum: string;
}

export interface LiveStubReport {
  contractSha: string;
  routesAligned: true;
  firmwareUrl: null;
  origin: string;
  integrationsPrefix: typeof INTEGRATIONS_API_PREFIX;
  healthPath: "/healthz";
  healthStatus: number;
  healthOk: boolean;
  profile: SkippedCall | LiveProfileHit;
  camera: SkippedCall | LiveCameraHit;
  /** Routes this probe does not call. Flash is never one of them. */
  notCalled: readonly string[];
}

const NOT_CALLED = [
  "POST /api/integrations/v1/consent/authorization-codes",
  "POST /api/integrations/v1/grants/exchange",
  "POST /api/integrations/v1/grants/{authorizationRef}/revoke",
  "POST /api/integrations/v1/grants/{authorizationRef}/rebind",
  "PUT /api/integrations/v1/grants/{authorizationRef}/device-capabilities",
  "POST /api/integrations/v1/conversations",
  "GET /api/integrations/v1/runs/{runId}/events",
  "flash",
  "massFlash",
] as const;

export interface LiveStubProbeOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  camera?: boolean;
  now?: () => number;
}

/**
 * Calls loopback `GET /healthz`, then the digital-human GET when service
 * credentials are complete. Camera runs only when `camera` is set and the
 * grant fields are present. The image is the 1×1 lab fixture.
 */
export async function runLiveStubProbe(options: LiveStubProbeOptions): Promise<LiveStubReport> {
  const location = stubLocationFromEnv(options.env);
  if (location === undefined) {
    throw new Error("OPENBOT_DEVICE_DH_STUB_URL is unset");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const health = await fetchImpl(`${location.origin}${location.healthPath}`);
  const healthOk = health.ok;
  await health.body?.cancel();
  const profile = healthOk ? await readProfile(location, options.env, fetchImpl) : skipped("healthz failed");
  const camera = healthOk ? await readCamera(location, options) : skipped("healthz failed");
  return {
    contractSha: OPENBOT_CONTRACT_SHA,
    routesAligned: CONTRACT_PIN.routesAligned,
    firmwareUrl: null,
    origin: location.origin,
    integrationsPrefix: INTEGRATIONS_API_PREFIX,
    healthPath: location.healthPath,
    healthStatus: health.status,
    healthOk,
    profile,
    camera,
    notCalled: NOT_CALLED,
  };
}

export function formatLiveStubReport(report: LiveStubReport): string {
  const profile =
    report.profile.state === "ok"
      ? `B1 digitalHumanId=${report.profile.digitalHumanId}`
      : `B1 skipped: ${report.profile.reason}`;
  const camera =
    report.camera.state === "ok"
      ? `camera ${report.camera.contentType} ${report.camera.width}x${report.camera.height}`
      : `camera skipped: ${report.camera.reason}`;
  return [
    `合约针: ${report.contractSha}`,
    `routesAligned: ${report.routesAligned}`,
    `firmwareUrl: ${String(report.firmwareUrl)}`,
    `stub: ${report.origin}`,
    `prefix: ${report.integrationsPrefix}`,
    `GET ${report.healthPath} -> ${report.healthStatus}`,
    profile,
    camera,
    "未调用:",
    ...report.notCalled.map((line) => `- ${line}`),
    "不是灰度交付，不是真机摄像头，也不会烧录。",
  ].join("\n");
}

function skipped(reason: string): SkippedCall {
  return { state: "skipped", reason };
}

async function readProfile(
  location: StubLocation,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<SkippedCall | LiveProfileHit> {
  if (serviceGrantHeaders(env) === undefined) {
    return skipped("service basic and grant credential are unset");
  }
  const id = env[STUB_DIGITAL_HUMAN_ID_ENV] ?? "dh-stub";
  const profile = await readDigitalHuman(id, { env: { ...env, [LIVE_STUB_ENV]: location.origin }, fetchImpl });
  return { state: "ok", digitalHumanId: profile.digitalHumanId };
}

async function readCamera(location: StubLocation, options: LiveStubProbeOptions): Promise<SkippedCall | LiveCameraHit> {
  if (options.camera !== true) {
    return skipped("camera flag is off");
  }
  const headers = serviceGrantHeaders(options.env);
  if (headers === undefined) {
    return skipped("service basic and grant credential are unset");
  }
  const request = cameraRequest(options.env, options.now ?? Date.now);
  if (request === undefined) {
    return skipped("authorizationRef, bindingVersion, and deviceId are unset");
  }
  const session = new LabCameraSession(new ControlPlane(options.now === undefined ? {} : { now: options.now }));
  const captured = await runLabCameraCapture(session, request, {
    baseUrl: location.origin,
    headers,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (captured.status !== "ok" || captured.result === null) {
    throw new Error(`live camera result was ${captured.status}`);
  }
  return {
    state: "ok",
    contentType: captured.result.contentType,
    width: captured.result.width,
    height: captured.result.height,
    checksum: captured.result.checksum,
  };
}

function cameraRequest(env: NodeJS.ProcessEnv, now: () => number): CameraToolRequest | undefined {
  const authorizationRef = env[STUB_AUTHORIZATION_REF_ENV];
  const deviceId = env[STUB_DEVICE_ID_ENV];
  const versionRaw = env[STUB_BINDING_VERSION_ENV];
  const versionSet = versionRaw !== undefined && versionRaw.length > 0;
  if (
    (authorizationRef === undefined || authorizationRef.length === 0) &&
    (deviceId === undefined || deviceId.length === 0) &&
    !versionSet
  ) {
    return undefined;
  }
  if (authorizationRef === undefined || authorizationRef.length === 0 || deviceId === undefined || deviceId.length === 0 || !versionSet) {
    throw new Error("camera live mode needs authorizationRef, bindingVersion, and deviceId together");
  }
  if (versionRaw === undefined || !/^[0-9]+$/.test(versionRaw)) {
    throw new Error("OPENBOT_STUB_BINDING_VERSION must be an integer");
  }
  return {
    requestId: `lab-cam-${now()}`,
    authorizationRef,
    bindingVersion: Number(versionRaw),
    deviceId,
    contentType: "image/png",
  };
}
