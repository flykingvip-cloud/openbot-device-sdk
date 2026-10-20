import {
  LIVE_STUB_ENV,
  assertFrozenBinding,
  cloneAssistant,
  standInApi,
  type AssistantFields,
  type FrozenBinding,
} from "../../../contracts/src/index.ts";

export interface DigitalHumanProfile {
  digitalHumanId: string;
  assistant: AssistantFields;
  authorizationRef?: string;
  bindingVersion?: number;
  deviceId?: string;
}

export interface B1Plane {
  findByDigitalHuman(digitalHumanId: string): readonly FrozenBinding[];
}

export interface B1Options {
  plane?: B1Plane;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Replays the first profile for this key and does not read the plane or stub again. */
  idempotencyKey?: string;
  /** Used when `plane` is omitted (live stub). A plane keeps its own cache. */
  idempotency?: Map<string, DigitalHumanProfile>;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const cacheByPlane = new WeakMap<object, Map<string, DigitalHumanProfile>>();

/**
 * Consumer for stand-in B1 `GET /v1/digital-humans/{digitalHumanId}`.
 * Without `OPENBOT_DEVICE_DH_STUB_URL`, reads the local control plane.
 * With the env set, GETs the stub and checks frozen field names.
 * A repeated `idempotencyKey` returns the first profile unchanged.
 */
export async function readDigitalHuman(digitalHumanId: string, options: B1Options = {}): Promise<DigitalHumanProfile> {
  const cached = lookupCache(options, digitalHumanId);
  if (cached) {
    return cached;
  }
  const profile = await loadDigitalHuman(digitalHumanId, options);
  storeCache(options, digitalHumanId, profile);
  return profile;
}

async function loadDigitalHuman(digitalHumanId: string, options: B1Options): Promise<DigitalHumanProfile> {
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

function lookupCache(options: B1Options, digitalHumanId: string): DigitalHumanProfile | undefined {
  const cache = cacheMap(options, false);
  if (!cache) {
    return undefined;
  }
  const found = cache.get(cacheKey(digitalHumanId, options.idempotencyKey ?? ""));
  return found === undefined ? undefined : structuredClone(found);
}

function storeCache(options: B1Options, digitalHumanId: string, profile: DigitalHumanProfile): void {
  const cache = cacheMap(options, true);
  if (!cache || options.idempotencyKey === undefined) {
    return;
  }
  cache.set(cacheKey(digitalHumanId, options.idempotencyKey), structuredClone(profile));
}

function cacheMap(options: B1Options, writing: boolean): Map<string, DigitalHumanProfile> | undefined {
  if (options.idempotencyKey === undefined) {
    return undefined;
  }
  if (!IDEMPOTENCY_KEY.test(options.idempotencyKey)) {
    throw new Error("idempotency key must match [A-Za-z0-9_.:-]{1,128}");
  }
  if (options.plane) {
    return planeCache(options.plane);
  }
  if (options.idempotency) {
    return options.idempotency;
  }
  if (writing) {
    throw new Error("openbot-b1 idempotencyKey requires a plane or an idempotency cache");
  }
  throw new Error("openbot-b1 idempotencyKey requires a plane or an idempotency cache");
}

/** Drops cached profiles for this plane. Rebind calls this so the next read loads the new grant. */
export function invalidateDigitalHumanCache(plane: object): void {
  cacheByPlane.delete(plane);
}

function planeCache(plane: object): Map<string, DigitalHumanProfile> {
  let cache = cacheByPlane.get(plane);
  if (!cache) {
    cache = new Map();
    cacheByPlane.set(plane, cache);
  }
  return cache;
}

function cacheKey(digitalHumanId: string, idempotencyKey: string): string {
  return `${idempotencyKey}\n${digitalHumanId}`;
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
    return {
      digitalHumanId: binding.digitalHumanId,
      assistant: binding.assistant,
      authorizationRef: binding.authorizationRef,
      bindingVersion: binding.bindingVersion,
      deviceId: binding.deviceId,
    };
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
