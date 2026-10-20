import assert from "node:assert/strict";
import test from "node:test";

import { readDigitalHuman } from "../integrations/openbot-b1/src/index.ts";
import { openDeviceSession } from "../integrations/openbot-b2/src/index.ts";
import { invokeOpenBotTool } from "../integrations/openbot-b3/src/index.ts";
import { chatEmotionPath, digitalHumanEmotionPath, emotionCategory } from "../sdk/src/media.ts";
import { describeSystemRebootCommand } from "../sdk/src/device-tools.ts";
import { ControlPlane } from "../services/src/index.ts";

function boundPlane(): { plane: ControlPlane; authorizationRef: string } {
  let refs = 0;
  const plane = new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => "100001",
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
  });
  plane.redeemClaim("dev-9", plane.issueClaim("dev-9").code);
  const binding = plane.bind({
    deviceId: "dev-9",
    digitalHumanId: "dh-9",
    assistant: { voiceId: "v", extra: true },
  });
  return { plane, authorizationRef: binding.authorizationRef };
}

test("media paths follow the firmware emotion tables", () => {
  assert.equal(emotionCategory("laughing"), "happy");
  assert.equal(emotionCategory("sad"), "crying");
  assert.equal(emotionCategory("not-a-real-emotion"), "neutral");
  assert.equal(digitalHumanEmotionPath("loving", ".eaf"), "system/emotion/loving.eaf");
  assert.equal(digitalHumanEmotionPath("loving", ".sjpg"), "system/emotion/loving.sjpg");
  assert.equal(chatEmotionPath("winking"), "system/chat/winking.eaf");
  assert.equal(chatEmotionPath("../etc/passwd"), "system/chat/neutral.eaf");
});

test("b1 b2 b3 consumers use the stand-in and reject disabled commands", async () => {
  const { plane, authorizationRef } = boundPlane();
  const profile = await readDigitalHuman("dh-9", { plane, env: {} });
  assert.equal(profile.digitalHumanId, "dh-9");
  assert.deepEqual(profile.assistant, { voiceId: "v", extra: true });

  const session = openDeviceSession(
    {
      authorizationRef,
      bindingVersion: 1,
      digitalHumanId: "dh-9",
      deviceId: "dev-9",
    },
    { plane, sessionId: () => "sess_lab" },
  );
  assert.equal(session.sessionId, "sess_lab");
  assert.equal(session.binding.assistant.voiceId, "v");
  assert.throws(
    () =>
      openDeviceSession(
        { authorizationRef: "aref_old", bindingVersion: 1, digitalHumanId: "dh-9", deviceId: "dev-9" },
        { plane },
      ),
    /frozen binding/,
  );

  const mapped = invokeOpenBotTool("emotion.map", { emotion: "kissy" });
  assert.equal(mapped.standIn, "B3");
  assert.deepEqual(mapped.result, {
    name: "emotion.map",
    category: "loving",
    chatPath: "system/chat/kissy.eaf",
  });
  assert.throws(() => invokeOpenBotTool("ota.flash"), /disabled/);
  assert.throws(() => invokeOpenBotTool("ota.massFlash"), /disabled/);
  assert.throws(() => invokeOpenBotTool("system.reboot"), /disabled/);
  assert.equal(describeSystemRebootCommand().executable, false);
});
