import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OpusFrameTtsProvider,
  createMockAsrProvider,
  createProportionalSilenceTtsProvider,
  isWavBuffer,
} from "../adapters/voice/src/index.ts";
import { SERVER_SAMPLE_RATE_DEFAULT } from "../adapters/metalio/src/index.ts";
import {
  FORBIDDEN_PASSTHROUGH_HINTS,
  VOICE_HARNESS_ASSISTANT_DEFAULT,
  VOICE_HARNESS_PENDING,
  assertSpokenTtsProvider,
  buildKnownWavFixture,
  createMockAssistantDialogue,
  createVoiceLongitudinalHarness,
  formatVoiceHarnessReport,
  runVoiceHarnessSim,
} from "../services/src/voice-harness.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = "services/src/voice-harness-cli.ts";

test("known WAV fixture is non-empty binary, not UTF-8 listen hint", () => {
  const wav = buildKnownWavFixture();
  assert.equal(isWavBuffer(wav), true);
  assert.ok(wav.byteLength > 44);
  assert.ok(wav.includes(Buffer.from([0x00])));
  // Payload must not decode as pure printable UTF-8 listen text.
  const pcm = wav.subarray(44);
  assert.ok(pcm.includes(Buffer.from([0x00])));
});

test("spoken TTS gate rejects OpusFrameTtsProvider and accepts ProportionalSilence", () => {
  const ok = createProportionalSilenceTtsProvider({ msPerChar: 40 });
  assert.doesNotThrow(() => assertSpokenTtsProvider(ok));
  if ("destroy" in ok && typeof ok.destroy === "function") {
    ok.destroy();
  }
  const lab = new OpusFrameTtsProvider({ frameCount: 2, pcmMode: "silence" });
  assert.throws(() => assertSpokenTtsProvider(lab), /spoken TTS gate|OpusFrameTtsProvider/);
  lab.destroy();
});

test("mock assistant dialogue is assistant.final, not upload data.text", async () => {
  const dialogue = createMockAssistantDialogue(VOICE_HARNESS_ASSISTANT_DEFAULT);
  const spoken = await dialogue.reply("sim-asr-from-provider");
  assert.equal(spoken.eventType, "assistant.final");
  assert.equal(spoken.text, VOICE_HARNESS_ASSISTANT_DEFAULT);
  assert.ok(!FORBIDDEN_PASSTHROUGH_HINTS.includes(spoken.text as (typeof FORBIDDEN_PASSTHROUGH_HINTS)[number]));
  assert.notEqual(spoken.text, "lab-stub-upload-tag");
});

test("runVoiceHarnessSim covers checklist and exits conceptually ok", async () => {
  const report = await runVoiceHarnessSim();
  assert.equal(report.ok, true);
  assert.equal(report.layer, "sim");
  assert.equal(report.voiceJointUnchanged, true);
  assert.equal(report.simUnchanged, true);
  assert.deepEqual([...report.pending], [...VOICE_HARNESS_PENDING]);
  assert.ok(report.ttsFrameCountLong > report.ttsFrameCountShort);
  assert.equal(report.assistantText, VOICE_HARNESS_ASSISTANT_DEFAULT);
  assert.ok(!FORBIDDEN_PASSTHROUGH_HINTS.includes(report.asrText as (typeof FORBIDDEN_PASSTHROUGH_HINTS)[number]));

  const byId = new Map(report.checks.map((c) => [c.id, c]));
  for (const id of [
    "wav-fixture",
    "tts-spoken-gate",
    "tts-reject-opus-frame",
    "no-passthrough",
    "asr-from-provider",
    "assistant-reply",
    "tts-proportional",
    "abort",
    "revoke-auth",
  ]) {
    const check = byId.get(id);
    assert.ok(check, `missing check ${id}`);
    assert.equal(check.ok, true, `${id} should pass`);
  }

  const simLayer = report.layers.find((l) => l.layer === "sim");
  const realLayer = report.layers.find((l) => l.layer === "real");
  const deviceLayer = report.layers.find((l) => l.layer === "device");
  assert.equal(simLayer?.status, "partial");
  assert.equal(realLayer?.status, "JOINT_PENDING");
  assert.equal(deviceLayer?.status, "JOINT_PENDING");

  const formatted = formatVoiceHarnessReport(report);
  assert.match(formatted, /voice-harness/);
  assert.match(formatted, /NOT voice-joint/);
  assert.match(formatted, /AUTH_REVOKED/);
  assert.match(formatted, /layer\.sim: partial/);
  assert.match(formatted, /layer\.real: JOINT_PENDING/);
});

test("runVoiceHarnessSim fails non-zero path when spoken TTS is OpusFrame", async () => {
  const lab = new OpusFrameTtsProvider({ frameCount: 3, pcmMode: "silence" });
  try {
    await assert.rejects(
      () => runVoiceHarnessSim({ tts: lab, runRevokeContract: false }),
      /voice-harness sim failed|spoken TTS gate|OpusFrameTtsProvider/,
    );
  } finally {
    lab.destroy();
  }
});

test("layered harness: real/device stay JOINT_PENDING", async () => {
  const harness = createVoiceLongitudinalHarness();
  const real = await harness.runReal();
  const device = await harness.runDevice();
  assert.equal(real.layer, "real");
  assert.equal(device.layer, "device");
  assert.equal(real.layers.find((l) => l.layer === "real")?.status, "JOINT_PENDING");
  assert.equal(device.layers.find((l) => l.layer === "device")?.status, "JOINT_PENDING");
});

test("voice-harness CLI: help + sim exit 0 on pass", () => {
  const help = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli, "--help"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /voice-harness/);
  assert.match(help.stdout, /voice-joint/);
  assert.match(help.stdout, /ProportionalSilence/);
  assert.match(help.stdout, /AUTH_REVOKED/);
  assert.equal(help.stdout.includes("api.tenclass.net"), false);

  const sim = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli, "--sim"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(sim.status, 0, sim.stderr || sim.stdout);
  assert.match(sim.stdout, /ok: true/);
  assert.match(sim.stdout, /layer\.sim: partial/);
  assert.match(sim.stdout, /ok asr-from-provider/);
  assert.match(sim.stdout, /ok revoke-auth/);
});

test("voice-harness CLI: unknown layer arg fails non-zero", () => {
  const bad = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli, "--layer", "staging"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(bad.status, 0);
});

test("injected mock ASR still forbids passthrough-looking transcripts as harness ASR source", async () => {
  // Provider that returns a forbidden passthrough string must fail the harness.
  const evil = {
    async transcribe() {
      return "from-query-transcript";
    },
  };
  const tts = createProportionalSilenceTtsProvider({ msPerChar: 40 });
  try {
    await assert.rejects(
      () =>
        runVoiceHarnessSim({
          asr: evil,
          tts,
          runRevokeContract: false,
        }),
      /voice-harness sim failed|passthrough|no-passthrough/,
    );
  } finally {
    if ("destroy" in tts && typeof tts.destroy === "function") {
      tts.destroy();
    }
  }
});

test("default mock ASR path via createMockAsrProvider still works when injected", async () => {
  const report = await runVoiceHarnessSim({
    asr: createMockAsrProvider(),
    assistantReply: "custom-assistant",
    runRevokeContract: true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.assistantText, "custom-assistant");
  // Binary WAV → MockAsr default lab-transcript (not a passthrough hint).
  assert.ok(!FORBIDDEN_PASSTHROUGH_HINTS.includes(report.asrText as (typeof FORBIDDEN_PASSTHROUGH_HINTS)[number]));
  assert.equal(report.ttsFrameCountShort >= 1, true);
  void SERVER_SAMPLE_RATE_DEFAULT;
});
