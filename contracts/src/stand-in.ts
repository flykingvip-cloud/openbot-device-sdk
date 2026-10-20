import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DIGITAL_HUMAN_PROFILE_PATH } from "./consumer-mirror.ts";
import {
  INVALIDATED_CONTRACT_SHAS,
  OPENBOT_CONTRACT_PR,
  OPENBOT_CONTRACT_REPO,
  OPENBOT_CONTRACT_SHA,
  PREVIOUS_CONTRACT_SHA,
} from "./pin.ts";

export interface StandInApi {
  id: "B0" | "B1" | "B2" | "B3" | "B4" | "B5";
  name: string;
  method: "GET" | "POST";
  path: string;
  consumer: string | null;
  flash?: false;
}

export interface StandInConsumerChecks {
  B1: ["idempotent-read"];
  B2: ["idempotency-key", "SESSION_BUSY", "CURSOR_EXPIRED", "eventId-dedupe"];
  B3: ["idempotency-key", "assistant.visible-only-tts"];
}

export interface StandInDocument {
  kind: "openbot-device-api-stand-in";
  status: "local-stand-in";
  routeSource: "local-stand-in";
  contract: {
    sha: typeof OPENBOT_CONTRACT_SHA;
    repo: typeof OPENBOT_CONTRACT_REPO;
    pr: typeof OPENBOT_CONTRACT_PR;
    status: "main";
    merge: "squash";
    officialMergeSha: typeof OPENBOT_CONTRACT_SHA;
    previousSha: typeof PREVIOUS_CONTRACT_SHA;
    previousShaStatus: "invalidated";
    invalidatedShas: typeof INVALIDATED_CONTRACT_SHAS;
    deviceApiRange: "B0-B5";
    deviceApisPresent: "reported-stub";
    routesAligned: true;
    access: "vendored";
    obsolete: {
      shaPrefix: "68e062e";
      repo: "https://github.com/upbeyond/openbot";
      status: "obsolete";
    };
    liveStubEnv: "OPENBOT_DEVICE_DH_STUB_URL";
    note: string;
  };
  consumerChecks: StandInConsumerChecks;
  frozenFields: {
    topLevel: ["authorizationRef", "bindingVersion", "digitalHumanId", "deviceId"];
    prefixes: ["assistant."];
  };
  apis: StandInApi[];
}

const REQUIRED_IDS = ["B0", "B1", "B2", "B3", "B4", "B5"] as const;

const MOCK_ROUTES: Record<(typeof REQUIRED_IDS)[number], { method: "GET" | "POST"; path: string }> = {
  B0: { method: "GET", path: "/v1/device/capabilities" },
  B1: { method: "GET", path: DIGITAL_HUMAN_PROFILE_PATH },
  B2: { method: "POST", path: "/v1/device/sessions" },
  B3: { method: "POST", path: "/v1/device/tools:invoke" },
  B4: { method: "GET", path: "/v1/device/media/capabilities" },
  B5: { method: "GET", path: "/v1/device/ota" },
};

function assertExactList(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${label} mismatch`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedItem = expected[index];
    if (expectedItem === undefined || value[index] !== expectedItem) {
      throw new Error(`${label} mismatch`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStandInDocument(value: unknown): StandInDocument {
  if (!isRecord(value) || value.kind !== "openbot-device-api-stand-in" || value.status !== "local-stand-in") {
    throw new Error("stand-in document kind mismatch");
  }
  if (value.routeSource !== "local-stand-in") {
    throw new Error("B0-B5 stand-in table must stay local even when the OpenAPI is vendored");
  }
  if (!isRecord(value.contract) || value.contract.sha !== OPENBOT_CONTRACT_SHA || value.contract.repo !== OPENBOT_CONTRACT_REPO) {
    throw new Error("stand-in document is not pinned to flykingvip-cloud/openbot-vp");
  }
  if (value.contract.pr !== OPENBOT_CONTRACT_PR || value.contract.status !== "main" || value.contract.merge !== "squash") {
    throw new Error("stand-in pin must be the squash merge of openbot-vp pull 10 on main");
  }
  if (value.contract.officialMergeSha !== OPENBOT_CONTRACT_SHA || value.contract.previousSha !== PREVIOUS_CONTRACT_SHA) {
    throw new Error("official merge SHA must be the current pin; previousSha must record the invalidated prior pin");
  }
  if (value.contract.previousShaStatus !== "invalidated") {
    throw new Error("previousSha is invalidated and must not be used as the pin");
  }
  assertExactList(value.contract.invalidatedShas, INVALIDATED_CONTRACT_SHAS, "invalidated SHAs");
  if ((INVALIDATED_CONTRACT_SHAS as readonly string[]).includes(OPENBOT_CONTRACT_SHA)) {
    throw new Error("current pin is an invalidated SHA");
  }
  if (
    value.contract.deviceApiRange !== "B0-B5" ||
    value.contract.deviceApisPresent !== "reported-stub" ||
    value.contract.routesAligned !== true ||
    value.contract.access !== "vendored"
  ) {
    throw new Error("stand-in pin must record the vendored OpenAPI alignment");
  }
  if (typeof value.contract.note !== "string" || value.contract.note.length === 0) {
    throw new Error("stand-in note is missing");
  }
  if (!isRecord(value.consumerChecks)) {
    throw new Error("stand-in consumer checks missing");
  }
  assertExactList(value.consumerChecks.B1, ["idempotent-read"], "B1 checks");
  assertExactList(
    value.consumerChecks.B2,
    ["idempotency-key", "SESSION_BUSY", "CURSOR_EXPIRED", "eventId-dedupe"],
    "B2 checks",
  );
  assertExactList(value.consumerChecks.B3, ["idempotency-key", "assistant.visible-only-tts"], "B3 checks");
  if (!isRecord(value.frozenFields)) {
    throw new Error("frozen fields missing");
  }
  assertExactList(
    value.frozenFields.topLevel,
    ["authorizationRef", "bindingVersion", "digitalHumanId", "deviceId"],
    "frozen fields",
  );
  assertExactList(value.frozenFields.prefixes, ["assistant."], "frozen prefixes");
  if (!Array.isArray(value.apis)) {
    throw new Error("stand-in apis missing");
  }
  const ids = value.apis.map((api) => (isRecord(api) ? api.id : undefined));
  for (const id of REQUIRED_IDS) {
    if (!ids.includes(id)) {
      throw new Error(`stand-in missing ${id}`);
    }
    const api = value.apis.find((item) => isRecord(item) && item.id === id);
    const route = MOCK_ROUTES[id];
    if (!isRecord(api) || api.method !== route.method || api.path !== route.path) {
      throw new Error(`stand-in ${id} route drifted from the local mock`);
    }
  }
  const b5 = value.apis.find((api) => isRecord(api) && api.id === "B5");
  if (!isRecord(b5) || b5.flash !== false) {
    throw new Error("B5 stand-in must not flash");
  }
  return value as unknown as StandInDocument;
}

export function loadStandInDocument(): StandInDocument {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../stand-in/b0-b5.json");
  return parseStandInDocument(JSON.parse(readFileSync(path, "utf8")));
}

export function standInApi(id: StandInApi["id"]): StandInApi {
  const api = loadStandInDocument().apis.find((item) => item.id === id);
  if (!api) {
    throw new Error(`stand-in missing ${id}`);
  }
  return api;
}
