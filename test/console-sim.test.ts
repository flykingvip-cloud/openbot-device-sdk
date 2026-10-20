import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OPENBOT_CONTRACT_SHA } from "../contracts/src/index.ts";
import { runConsoleDemo, runConsoleResume } from "../console/src/demo.ts";
import { runSimulator } from "../simulator/src/sim.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", ...args],
    { cwd: root, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("console demo persists revoke and refuses flash", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-console-"));
  const state = join(dir, "console.sqlite");
  const demo = runConsoleDemo(state);
  assert.equal(demo.contractSha, OPENBOT_CONTRACT_SHA);
  assert.equal(demo.contractSha, "92826116a9b00a596ae2360d8a643d6148050e3c");
  assert.equal(demo.claimCode, "042315");
  assert.equal(demo.bindingVersion, 2);
  assert.equal(demo.assistantPreserved, true);
  assert.equal(demo.otaExecutable, false);
  assert.equal(demo.otaFirmwareUrl, null);
  assert.equal(demo.flashCode, "ota_disabled");
  assert.equal(demo.massFlashCode, "mass_flash");
  assert.equal(demo.refreshRotated, true);
  assert.equal(demo.staleCameraCode, "credential_missing");
  assert.equal(demo.lateCameraCode, "camera_revoked");
  assert.equal(demo.reloadedRevoked, true);
  assert.equal(demo.reloadedLateCameraCode, "camera_revoked");
  assert.match(demo.lines.join("\n"), /404/);
  assert.doesNotMatch(demo.lines.join("\n"), /api\.tenclass\.net/);

  const resume = runConsoleResume(state);
  assert.equal(resume.bindingVersion, 2);
  assert.equal(resume.revoked, true);
  assert.equal(resume.cameraCode, "camera_revoked");
  assert.equal(resume.otaFirmwareUrl, null);
  assert.equal(resume.otaExecutable, false);
});

test("simulator covers B1-B3 stand-ins without flashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-sim-"));
  const report = await runSimulator(join(dir, "sim.sqlite"));
  assert.equal(report.contractSha, "92826116a9b00a596ae2360d8a643d6148050e3c");
  assert.equal(report.b1Idempotent, true);
  assert.equal(report.assistantPreserved, true);
  assert.equal(report.idempotentSession, true);
  assert.equal(report.sessionBusy, true);
  assert.equal(report.duplicateEventIgnored, true);
  assert.equal(report.duplicateSurvivedRestart, true);
  assert.equal(report.cursorExpired, true);
  assert.equal(report.visibleTtsText, "visible-speech-only");
  assert.equal(report.visibleTtsExcludesSecret, true);
  assert.equal(report.refreshRotated, true);
  assert.equal(report.oldTokenRejected, true);
  assert.equal(report.lateCameraCode, "camera_revoked");
  assert.equal(report.flashCode, "ota_disabled");
  assert.equal(report.massFlashCode, "mass_flash");
  assert.equal(report.otaFirmwareUrl, null);
  assert.equal(report.otaExecutable, false);
  assert.equal(report.reloadedRevoked, true);
  assert.equal(report.reloadedLateCameraCode, "camera_revoked");
  assert.equal(report.reloadedCursorExpired, true);
  assert.equal(report.reloadedSessionClosed, true);
  const text = report.lines.join("\n");
  assert.match(text, /404/);
  assert.equal(text.includes("do-not-speak-secret"), false);
});

test("console and sim CLIs print the official main pin", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-cli-"));
  const consoleState = join(dir, "console.sqlite");
  const demo = runCli(["console/src/cli.ts", "--state", consoleState]);
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /92826116a9b00a596ae2360d8a643d6148050e3c/);
  assert.match(demo.stdout, /d22db4755311a1a0df9fb5e3d5da60554f8ef6a5/);
  assert.match(demo.stdout, /bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a/);
  assert.match(demo.stdout, /41b7561222775e4ad00b056e2a535c7f950bcbe9/);
  assert.match(demo.stdout, /536a963b119f0a00675516401c52dd0f6187b196/);
  assert.match(demo.stdout, /8abdc7f9a0ae49c340de712fbba235b1064f6c7d/);
  assert.match(demo.stdout, /554910d835f3baadb1d753532ad510b1b477be09/);
  assert.match(demo.stdout, /dd6c85cae086d90c519ff1be7ad08e20d4644bba/);
  assert.match(demo.stdout, /ota_disabled/);
  assert.match(demo.stdout, /mass_flash/);
  assert.match(demo.stdout, /camera_revoked/);
  assert.match(demo.stdout, /404/);
  const resume = runCli(["console/src/cli.ts", "--state", consoleState, "--resume"]);
  assert.equal(resume.status, 0, resume.stderr);
  assert.match(resume.stdout, /bindingVersion=2/);
  assert.match(resume.stdout, /camera_revoked/);
  const sim = runCli(["simulator/src/cli.ts", "--state", join(dir, "sim.sqlite")]);
  assert.equal(sim.status, 0, sim.stderr);
  assert.match(sim.stdout, /SESSION_BUSY=true/);
  assert.match(sim.stdout, /CURSOR_EXPIRED=true/);
  assert.match(sim.stdout, /mass_flash/);
  assert.equal(sim.stdout.includes("do-not-speak-secret"), false);
});
