import assert from "node:assert/strict";
import test from "node:test";

import { LIVE_STUB_ENV } from "../contracts/src/index.ts";
import { readDigitalHuman } from "../integrations/openbot-b1/src/index.ts";

test(
  "live digital-human stub",
  { skip: process.env[LIVE_STUB_ENV] ? false : "OPENBOT_DEVICE_DH_STUB_URL is unset; waiting for an Agent B SHA" },
  async () => {
    const base = process.env[LIVE_STUB_ENV];
    assert.ok(base);
    const id = process.env.OPENBOT_DEVICE_DH_STUB_ID ?? "dh-stub";
    const profile = await readDigitalHuman(id, { env: process.env });
    assert.equal(profile.digitalHumanId, id);
    assert.equal(typeof profile.assistant, "object");
  },
);
