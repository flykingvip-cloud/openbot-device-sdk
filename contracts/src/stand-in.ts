import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OPENBOT_CONTRACT_REPO, OPENBOT_CONTRACT_SHA } from "./pin.ts";

export interface StandInApi {
  id: "B0" | "B1" | "B2" | "B3" | "B4" | "B5";
  name: string;
  method: "GET" | "POST";
  path: string;
  consumer: string | null;
  flash?: false;
}

export interface StandInDocument {
  kind: "openbot-device-api-stand-in";
  status: "local-stand-in";
  contract: {
    sha: typeof OPENBOT_CONTRACT_SHA;
    repo: typeof OPENBOT_CONTRACT_REPO;
    snapshot: "parentless-recovery";
    deviceApisPresent: false;
    deviceApiRange: "B0-B5";
    obsolete: {
      shaPrefix: "68e062e";
      repo: "https://github.com/upbeyond/openbot";
      status: "obsolete";
    };
    liveStubEnv: "OPENBOT_DEVICE_DH_STUB_URL";
    note: string;
  };
  frozenFields: {
    topLevel: ["authorizationRef", "bindingVersion", "digitalHumanId", "deviceId"];
    prefixes: ["assistant."];
  };
  apis: StandInApi[];
}

const REQUIRED_IDS = ["B0", "B1", "B2", "B3", "B4", "B5"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStandInDocument(value: unknown): StandInDocument {
  if (!isRecord(value) || value.kind !== "openbot-device-api-stand-in" || value.status !== "local-stand-in") {
    throw new Error("stand-in document kind mismatch");
  }
  if (!isRecord(value.contract) || value.contract.sha !== OPENBOT_CONTRACT_SHA || value.contract.repo !== OPENBOT_CONTRACT_REPO) {
    throw new Error("stand-in document is not pinned to flykingvip-cloud/openbot-vp");
  }
  if (value.contract.deviceApisPresent !== false || value.contract.snapshot !== "parentless-recovery") {
    throw new Error("stand-in document must keep B0-B5 unpublished");
  }
  if (!Array.isArray(value.apis)) {
    throw new Error("stand-in apis missing");
  }
  const ids = value.apis.map((api) => (isRecord(api) ? api.id : undefined));
  for (const id of REQUIRED_IDS) {
    if (!ids.includes(id)) {
      throw new Error(`stand-in missing ${id}`);
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
