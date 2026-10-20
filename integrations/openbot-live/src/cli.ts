import { LIVE_STUB_ENV, stubLocationFromEnv } from "../../../contracts/src/index.ts";
import { formatLiveStubReport, runLiveStubProbe } from "./index.ts";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (stubLocationFromEnv(process.env) === undefined) {
    process.stdout.write(`${helpText()}\n未设置 ${LIVE_STUB_ENV}，不访问网络。\n`);
    return;
  }
  void runLiveStubProbe({ env: process.env, camera: args.camera })
    .then((report) => {
      process.stdout.write(`${formatLiveStubReport(report)}\n`);
      if (!report.healthOk) {
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

function parseArgs(argv: string[]): { help: boolean; camera: boolean } {
  let help = false;
  let camera = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--camera") {
      camera = true;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return { help, camera };
}

function helpText(): string {
  return [
    "用法: OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787 npm run live-stub -- [--camera]",
    "GET /healthz 在 stub 根上。其余路径在 /api/integrations/v1 下。",
    "数字人 GET 需要 service Basic 和 X-OpenBot-Grant-Credential。口令见 openbot-vp staging.md，不写进本仓库。",
    "未设置凭证时跳过数字人、会话、工具和媒体写路径。",
    "--camera 只用 1×1 PNG 夹具，走上传票据和 device-tool result。不是 OV2710。",
    "不调用 flash 或 massFlash。firmwareUrl 保持 null。",
  ].join("\n");
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
