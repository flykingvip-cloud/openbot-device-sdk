import assert from "node:assert/strict";
import test from "node:test";

import { FrozenFieldError, assertFrozenBinding, assistantEqual } from "../contracts/src/index.ts";
import { ControlPlane, OtaDisabledError } from "../services/src/index.ts";

function plane(): ControlPlane {
  let refs = 0;
  return new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => "042315",
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
  });
}

const assistant = {
  voiceId: "voice-1",
  locale: "zh-CN",
  nested: { style: "calm" },
};

test("claim then bind preserves assistant.* and frozen names", () => {
  const control = plane();
  const ticket = control.issueClaim("dev-1");
  assert.equal(ticket.code, "042315");
  control.redeemClaim("dev-1", ticket.code);
  const binding = control.bind({
    deviceId: "dev-1",
    digitalHumanId: "dh-1",
    assistant,
  });
  assert.equal(binding.authorizationRef, "aref_1");
  assert.equal(binding.bindingVersion, 1);
  assert.equal(binding.deviceId, "dev-1");
  assert.equal(binding.digitalHumanId, "dh-1");
  assert.equal(assistantEqual(binding.assistant, assistant), true);
  assert.deepEqual(Object.keys(binding).sort(), [
    "assistant",
    "authorizationRef",
    "bindingVersion",
    "deviceId",
    "digitalHumanId",
  ]);
});

test("aliases and assistant rewrites are rejected", () => {
  const control = plane();
  control.redeemClaim("dev-1", control.issueClaim("dev-1").code);
  assert.throws(
    () =>
      control.bind({
        deviceId: "dev-1",
        digitalHumanId: "dh-1",
        assistant,
        device_id: "other",
      } as never),
    FrozenFieldError,
  );
  control.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant });
  assert.throws(() => control.rebind("dev-1", { assistant: { voiceId: "other" } }), FrozenFieldError);
  assert.throws(() => control.rebind("dev-1", { deviceId: "dev-2" }), FrozenFieldError);
  assert.throws(() => control.rebind("dev-1", { authorizationRef: "aref_manual" }), FrozenFieldError);
});

test("rebind rotates authorizationRef and keeps assistant bytes", () => {
  const control = plane();
  control.redeemClaim("dev-1", control.issueClaim("dev-1").code);
  const first = control.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant });
  const second = control.rebind("dev-1", { digitalHumanId: "dh-2" });
  assert.equal(second.bindingVersion, 2);
  assert.equal(second.authorizationRef, "aref_2");
  assert.notEqual(second.authorizationRef, first.authorizationRef);
  assert.equal(second.deviceId, "dev-1");
  assert.equal(second.digitalHumanId, "dh-2");
  assert.equal(assistantEqual(second.assistant, first.assistant), true);
  assert.throws(
    () =>
      assertFrozenBinding({
        authorizationRef: "",
        bindingVersion: 0,
        digitalHumanId: "dh-2",
        deviceId: "dev-1",
        assistant: {},
      }),
    FrozenFieldError,
  );
});

test("lab OTA never stores a URL and flash stays disabled", () => {
  const control = plane();
  control.redeemClaim("dev-1", control.issueClaim("dev-1").code);
  control.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant: {} });
  const intent = control.proposeLabOta({ deviceId: "dev-1", version: "lab-0" });
  assert.equal(intent.executable, false);
  assert.equal(intent.firmwareUrl, null);
  assert.equal(intent.force, 0);
  assert.equal(intent.scope, "single-device");
  assert.throws(
    () => control.proposeLabOta({ deviceId: "dev-1", version: "1", firmwareUrl: "https://api.tenclass.net/xiaozhi/ota/fw.bin" }),
    (error: unknown) => error instanceof OtaDisabledError && error.code === "production_ota",
  );
  assert.throws(
    () =>
      control.proposeLabOta({
        deviceId: "dev-1",
        version: "1",
        firmwareUrl: "https://cloudzaoai.oss-rg-china-mainland.aliyuncs.com/c5_hosted_2.12.12.bin",
      }),
    (error: unknown) => error instanceof OtaDisabledError && error.code === "production_ota",
  );
  assert.throws(
    () => control.proposeLabOta({ deviceId: "dev-1", version: "1", firmwareUrl: "http://127.0.0.1/lab.bin" }),
    (error: unknown) => error instanceof OtaDisabledError && error.code === "firmware_url",
  );
  assert.throws(
    () => control.proposeLabOta({ deviceId: "dev-1", version: "1", force: 1 }),
    (error: unknown) => error instanceof OtaDisabledError && error.code === "force_flag",
  );
  assert.throws(
    () => control.proposeLabOta({ deviceId: "dev-1", version: "1", rollout: "mass" }),
    (error: unknown) => error instanceof OtaDisabledError && error.code === "production_ota",
  );
  assert.throws(
    () => control.proposeLabOta({ deviceId: "dev-1", version: "1", scope: "fleet" }),
    (error: unknown) => error instanceof OtaDisabledError && error.code === "mass_flash",
  );
  assert.throws(() => control.flash(), OtaDisabledError);
  assert.throws(() => control.massFlash(), OtaDisabledError);
});
