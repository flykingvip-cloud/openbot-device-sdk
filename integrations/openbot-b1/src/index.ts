import {
  LIVE_STUB_ENV,
  assertFrozenBinding,
  cloneAssistant,
  standInApi,
  type AssistantFields,
  type FrozenBinding,
} from "../../../contracts/src/index.ts";
import type { ControlPlane } from "../../../services/src/index.ts";

export interface DigitalHumanProfile {
  digitalHumanId: string;
  assistant: AssistantFields;
  authorizationRef?: string;
  bindingVersion?: number;
  deviceId?: string;
}

export interface B1Options {
  plane?: ControlPlane;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Consumer for stand-in B1 `GET /v1/digital-humans/{digitalHumanId}`.
 * Without `OPENBOT_DEVICE_DH_STUB_URL`, reads the local control plane.
 * With the env set, GETs the stub and checks frozen field names.
 */
export async function readDigitalHuman(digitalHumanId: string, options: B1Options = {}): Promise<DigitalHumanProfile> {
  const env = options.env ?? process.env;
  const stub = env[LIVE_STUB_ENV];
  if (stub !== undefined && stub.length > 0) {
    return readLiveStub(stub, digitalHumanId, options.fetchImpl ?? fetch);
  }
  if (!options.plane) {
    throw new Error("openbot-b1 stand-in requires a ControlPlane when OPENBOT_DEVICE_DH_STUB_URL is unset");
  }
  const api = standInApi("B1");
  if (api.path !== "/v1/digital-humans/{digitalHumanId}") {
    throw new Error("openbot-b1 stand-in path drifted");
  }
  const matches = options.plane.findByDigitalHuman(digitalHumanId);
  const first = matches[0];
  if (!first) {
    throw new Error(`digital human not bound: ${digitalHumanId}`);
  }
  for (const binding of matches) {
    if (JSON.stringify(binding.assistant) !== JSON.stringify(first.assistant)) {
      throw new Error("assistant.* diverged across bindings of the same digitalHumanId");
    }
  }
  return {
    digitalHumanId,
    assistant: cloneAssistant(first.assistant),
  };
}

async function readLiveStub(baseUrl: string, digitalHumanId: string, fetchImpl: typeof fetch): Promise<DigitalHumanProfile> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/digital-humans/${encodeURIComponent(digitalHumanId)}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`digital human stub failed: ${response.status}`);
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("digital human stub body is not an object");
  }
  const record = body as Record<string, unknown>;
  if (record.digitalHumanId !== digitalHumanId) {
    throw new Error("digital human stub returned a different digitalHumanId");
  }
  if (typeof record.authorizationRef === "string") {
    const binding: FrozenBinding = assertFrozenBinding(body);
    const profile: DigitalHumanProfile = {
      digitalHumanId: binding.digitalHumanId,
      assistant: binding.assistant,
      authorizationRef: binding.authorizationRef,
      bindingVersion: binding.bindingVersion,
      deviceId: binding.deviceId,
    };
    return profile;
  }
  const assistant = record.assistant;
  if (typeof assistant !== "object" || assistant === null || Array.isArray(assistant)) {
    throw new Error("digital human stub is missing assistant");
  }
  return {
    digitalHumanId,
    assistant: cloneAssistant(assistant as AssistantFields),
  };
}
