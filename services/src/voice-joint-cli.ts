import { LIVE_STUB_ENV } from "../../contracts/src/index.ts";
import {
  VOICE_JOINT_CONTROL_URL_ENV,
  VOICE_JOINT_TRANSCRIPT_ENV,
  formatVoiceJointReport,
  runVoiceJointLoopback,
  voiceJointMissingEnv,
} from "./voice-joint.ts";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const missing = voiceJointMissingEnv(process.env);
  if (missing.length > 0) {
    process.stdout.write(`${helpText()}\n`);
    process.stdout.write(`跳过 voice-joint / API-only。未设置: ${missing.join(", ")}。不访问网络。\n`);
    process.stdout.write("跳过不是通过。JOINT_PENDING: UI、staging、real-device、production。\n");
    process.stdout.write("本命令是 HTTP compat smoke，不是 voice E2E。不扩展 npm run sim。见 docs/integration/claw4-gateway-upload.md 与 docs/voice-longitudinal-harness.md。\n");
    return;
  }
  const options: { env: NodeJS.ProcessEnv; transcript?: string } = { env: process.env };
  if (args.transcript !== undefined) {
    options.transcript = args.transcript;
  }
  void runVoiceJointLoopback(options)
    .then((report) => {
      process.stdout.write(`${formatVoiceJointReport(report)}\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

function parseArgs(argv: string[]): { help: boolean; transcript: string | undefined } {
  let help = false;
  let transcript: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--transcript") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--") || next.length === 0) {
        throw new Error("--transcript 需要非空字符串（ASR/passthrough，不是 assistant.final）");
      }
      transcript = next;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg ?? ""}`);
  }
  return { help, transcript };
}

function helpText(): string {
  return [
    `用法: ${LIVE_STUB_ENV}=http://127.0.0.1:8787 npm run voice-joint -- [--transcript <text>]`,
    "HTTP compat smoke（方案 B1 / SDK A6）— 不是 voice E2E。主路径 OpenBot stub :8787；silent WAV + 可选 ?transcript= 透传。",
    "鉴权: Authorization Basic serviceClientId:secret + X-OpenBot-Grant-Credential + X-Device-Id(=grant.deviceId)。",
    "需要: OPENBOT_STUB_SERVICE_USER、OPENBOT_STUB_SERVICE_PASSWORD、OPENBOT_STUB_GRANT_CREDENTIAL、OPENBOT_STUB_DEVICE_ID。",
    `可选: ${VOICE_JOINT_TRANSCRIPT_ENV} 或 --transcript；${VOICE_JOINT_CONTROL_URL_ENV}=http://127.0.0.1:8791 探 device-control health（双命令）。`,
    "data.text = ASR/passthrough，不是 assistant.final。gateway :18789 未注入 DeviceDhService 时 /api/v1/* 可能 503 — 请用 stub 8787。",
    "权威: openbot-vp docs/integrations/device-digital-human/claw4-firmware-http-compat.md",
    "不实现 gateway 路由；不改 device-control OpenAPI；不扩展 npm run sim。纵向语音清单见 docs/voice-longitudinal-harness.md。",
    "口令见 openbot-vp staging.md，不要写进仓库。JOINT_PENDING: UI、staging、real-device、production。",
  ].join("\n");
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
