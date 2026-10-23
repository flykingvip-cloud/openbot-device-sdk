import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADAPTER_FAMILY_SLOTS,
  DEVICE_CAPABILITY_KEYS,
  FIRMWARE_SHA,
  METALIO_CAPABILITY_MATRIX,
  OPENBOT_CONTRACT_SHA,
  OPUS_SEMANTIC_ROLES,
  RECORD_CARD_CAPABILITY_MATRIX,
  assertsNoDeviceControlOpenApiForLocalCaps,
  getAdapterFamilySlot,
  getDeviceCapabilityMatrix,
  isSpeakerOptional,
  listAdapterFamilySlots,
  listDeviceCapabilityMatrices,
} from "../sdk/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("capability keys and adapter slots cover A5 declarations", () => {
  assert.deepEqual([...DEVICE_CAPABILITY_KEYS], ["mic", "storage", "ble", "usb", "speaker"]);
  assert.deepEqual([...ADAPTER_FAMILY_SLOTS], ["metalio", "record-card", "generic"]);
  assert.deepEqual([...OPUS_SEMANTIC_ROLES], ["broadcast-frame", "recording-storage"]);
});

test("metalio matrix owns broadcast-frame Opus; speaker/TTS optional", () => {
  const matrix = getDeviceCapabilityMatrix("metalio-claw-4");
  assert.ok(matrix);
  assert.equal(matrix, METALIO_CAPABILITY_MATRIX);
  assert.equal(matrix.adapter.slot, "metalio");
  assert.equal(matrix.adapter.opusRole, "broadcast-frame");
  assert.equal(matrix.adapter.status, "implemented");
  assert.equal(matrix.capabilities.mic.present, true);
  assert.equal(matrix.capabilities.storage.present, true);
  assert.equal(matrix.capabilities.speaker.present, "optional");
  assert.equal(matrix.ttsPlayback, "optional");
  assert.equal(isSpeakerOptional(matrix), true);
  assertsNoDeviceControlOpenApiForLocalCaps(matrix.adapter);
});

test("record-card matrix is placeholder recording-storage; no DC OpenAPI surface", () => {
  const matrix = RECORD_CARD_CAPABILITY_MATRIX;
  assert.equal(matrix.profileId, "record-card-generic");
  assert.equal(matrix.adapter.slot, "record-card");
  assert.equal(matrix.adapter.opusRole, "recording-storage");
  assert.equal(matrix.adapter.status, "placeholder");
  assert.equal(matrix.adapter.openApiSurface, "device-control-v1-forbidden");
  assert.equal(matrix.ttsPlayback, "unsupported");
  assert.equal(isSpeakerOptional(matrix), true);
  assertsNoDeviceControlOpenApiForLocalCaps(matrix.adapter);

  const readme = readFileSync(join(root, "adapters/record-card/README.md"), "utf8");
  assert.match(readme, /recording-storage/);
  assert.match(readme, /placeholder/i);
  assert.match(readme, /Must not/);
});

test("adapter registry lists all slots and generic is planned", () => {
  const slots = listAdapterFamilySlots();
  assert.equal(slots.length, 3);
  assert.equal(getAdapterFamilySlot("generic").status, "planned");
  assert.equal(getAdapterFamilySlot("generic").opusRole, null);
  for (const slot of slots) {
    assertsNoDeviceControlOpenApiForLocalCaps(slot);
  }
  assert.equal(listDeviceCapabilityMatrices().length, 2);
});

test("A5 does not change contract/firmware pins or device-control OpenAPI", () => {
  assert.equal(OPENBOT_CONTRACT_SHA, "d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f");
  assert.equal(FIRMWARE_SHA, "ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950");

  const openapi = readFileSync(join(root, "contracts/device-platform/device-control.openapi.yaml"), "utf8");
  assert.match(openapi, /^  version: v1$/m);
  assert.match(openapi, /\/api\/device-platform\/v1\/capabilities/);
  // Local hardware caps and record-card must not appear as paths or schema names.
  for (const banned of [
    "/ble",
    "/usb",
    "/speaker",
    "/mic",
    "/storage",
    "record-card",
    "recording-storage",
    "tenclass",
    "deviceCapabilityMatrix",
  ]) {
    assert.equal(openapi.includes(banned), false, `OpenAPI must not mention ${banned}`);
  }
  assert.equal(/^\s+- name: (ble|usb|mic|storage|speaker)\s*$/m.test(openapi), false);
});

test("opus roles stay segregated across presets", () => {
  assert.notEqual(METALIO_CAPABILITY_MATRIX.adapter.opusRole, RECORD_CARD_CAPABILITY_MATRIX.adapter.opusRole);
  assert.equal(METALIO_CAPABILITY_MATRIX.adapter.opusRole, "broadcast-frame");
  assert.equal(RECORD_CARD_CAPABILITY_MATRIX.adapter.opusRole, "recording-storage");
});
