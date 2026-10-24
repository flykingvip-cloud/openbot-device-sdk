import {
  createVoiceLongitudinalHarness,
  formatVoiceHarnessReport,
  runVoiceHarnessSim,
} from "./voice-harness.ts";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (args.layer === "real" || args.layer === "device") {
    const harness = createVoiceLongitudinalHarness();
    const run = args.layer === "real" ? harness.runReal() : harness.runDevice();
    void run
      .then((report) => {
        process.stdout.write(`${formatVoiceHarnessReport(report)}\n`);
        // Pending layers exit 0 but do not claim a pass — status is JOINT_PENDING in report.
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      });
    return;
  }

  // Default: sim — failures must exit non-zero.
  void runVoiceHarnessSim()
    .then((report) => {
      process.stdout.write(`${formatVoiceHarnessReport(report)}\n`);
      if (!report.ok) {
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

function parseArgs(argv: string[]): { help: boolean; layer: "sim" | "real" | "device" } {
  let help = false;
  let layer: "sim" | "real" | "device" = "sim";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--layer") {
      const next = argv[index + 1];
      if (next !== "sim" && next !== "real" && next !== "device") {
        throw new Error("--layer 需要 sim | real | device");
      }
      layer = next;
      index += 1;
      continue;
    }
    if (arg === "--sim") {
      layer = "sim";
      continue;
    }
    throw new Error(`未知参数: ${arg ?? ""}`);
  }
  return { help, layer };
}

function helpText(): string {
  return [
    "用法: npm run voice-harness            # 默认 sim 层",
    "      npm run voice-harness:sim        # 同默认",
    "      npm run voice-harness -- --layer real|device   # JOINT_PENDING 报告",
    "",
    "纵向 voice harness（P1-5）— 分层 sim / real / device。",
    "与 npm run voice-joint（HTTP compat smoke，silent WAV + 可选 ?transcript=）分离。",
    "sim 层：已知 WAV fixture + MockAsr / bridge.transcribeWav + mock assistant.final",
    "       + ProportionalSilenceTtsProvider + abort + 进程内 AUTH_REVOKED 契约 stub。",
    "禁止把 ?transcript= / X-Transcript-Text 当 ASR；禁止 OpusFrameTtsProvider 当 spoken TTS 过门。",
    "不捆绑 FunASR 权重。不扩展 npm run sim。不改 CONTROL / OpenAPI。不 PROMOTE。",
    "sim 失败退出码非 0。real/device 本片 JOINT_PENDING（文档门闩）。",
    "Revoke 真 stub 门闩 → Agent B :8787（OPENBOT_DEVICE_DH_STUB_URL）。",
    "清单: docs/voice-longitudinal-harness.md",
  ].join("\n");
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
