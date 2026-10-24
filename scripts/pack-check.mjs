#!/usr/bin/env node
/**
 * Build → npm pack → install tarball in a temp project → import smoke.
 * No real publish.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "@flykingvip-cloud/openbot-device-sdk";
const VER = "0.1.0";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
  if (r.status !== 0) {
    if (r.stdout) console.error(r.stdout);
    if (r.stderr) console.error(r.stderr);
    process.exit(r.status ?? 1);
  }
  return r;
}

run(process.execPath, [join(root, "scripts/build-voice-dist.mjs")], {
  stdio: "inherit",
});

const pack = run("npm", ["pack", "--json", "--ignore-scripts"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let meta;
try {
  meta = JSON.parse(pack.stdout.trim());
} catch {
  console.error("[pack-check] npm pack --json parse failed:", pack.stdout, pack.stderr);
  process.exit(1);
}
let tarName = Array.isArray(meta) ? meta[0]?.filename : meta?.filename;
if (!tarName || !existsSync(join(root, tarName))) {
  tarName = readdirSync(root).filter((f) => f.endsWith(".tgz")).sort().at(-1);
}
if (!tarName || !existsSync(join(root, tarName))) {
  console.error("[pack-check] tarball missing", meta);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "openbot-device-sdk-pack-"));
const tarPath = join(root, tarName);
try {
  // Inspect tarball contents without install
  const list = run("tar", ["-tzf", tarPath], { stdio: ["ignore", "pipe", "pipe"] });
  const entries = list.stdout.split("\n").filter(Boolean);
  for (const need of [
    "package/dist/voice/index.js",
    "package/dist/voice/index.d.ts",
    "package/dist/metalio/opus-encoder.js",
    "package/docs/npm-publish.md",
    "package/package.json",
  ]) {
    if (!entries.includes(need)) {
      console.error("[pack-check] missing in tarball:", need);
      process.exit(1);
    }
  }

  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ name: "pack-check-consumer", private: true, type: "module" }, null, 2),
  );
  const install = spawnSync("npm", ["install", tarPath], {
    cwd: work,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (install.status !== 0) {
    console.error(install.stdout, install.stderr);
    process.exit(install.status ?? 1);
  }

  const installedPkg = JSON.parse(
    readFileSync(join(work, "node_modules", PKG, "package.json"), "utf8"),
  );
  if (installedPkg.name !== PKG || installedPkg.version !== VER) {
    console.error("[pack-check] installed meta mismatch", installedPkg);
    process.exit(1);
  }

  const smoke = join(work, "smoke.mjs");
  writeFileSync(
    smoke,
    `
import {
  createAudioBridgeFromVoiceEnv,
  createAudioBridge,
  createReferenceHttpAsrProvider,
  DEVICE_SDK_ROOT_ENV,
} from ${JSON.stringify(PKG)};
import { createAudioBridge as fromVoice } from ${JSON.stringify(PKG + "/voice")};
const bridge = createAudioBridgeFromVoiceEnv();
if (typeof bridge.transcribeWav !== "function") throw new Error("no transcribeWav");
if (DEVICE_SDK_ROOT_ENV !== "OPENBOT_DEVICE_SDK_ROOT") throw new Error("env const");
if (typeof createAudioBridge !== "function" || typeof fromVoice !== "function") {
  throw new Error("bridge export");
}
if (typeof createReferenceHttpAsrProvider !== "function") throw new Error("ref asr");
console.log("[pack-check] import smoke ok", ${JSON.stringify(PKG)}, ${JSON.stringify(VER)});
`,
  );
  const smokeRun = spawnSync(process.execPath, [smoke], {
    cwd: work,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (smokeRun.status !== 0) {
    console.error(smokeRun.stdout, smokeRun.stderr);
    process.exit(smokeRun.status ?? 1);
  }
  process.stdout.write(smokeRun.stdout);
  console.log("[pack-check] tarball", tarName, "ok");
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(tarPath, { force: true });
}
