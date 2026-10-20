import { LIVE_STUB_ENV } from "../../contracts/src/index.ts";
import { formatSimJointReport, runSimJointLoopback, simJointMissingEnv } from "./sim-joint.ts";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const missing = simJointMissingEnv(process.env);
  if (missing.length > 0) {
    process.stdout.write(`${helpText()}\n`);
    process.stdout.write(`跳过 sim / API-only。未设置: ${missing.join(", ")}。不访问网络。\n`);
    process.stdout.write("跳过不是通过。JOINT_PENDING: UI、staging、real-device、production。\n");
    return;
  }
  const options: { env: NodeJS.ProcessEnv; port: number; digitalHumanIdB?: string } = {
    env: process.env,
    port: 8791,
  };
  if (args.digitalHumanB !== undefined) {
    options.digitalHumanIdB = args.digitalHumanB;
  }
  void runSimJointLoopback(options)
    .then((report) => {
      process.stdout.write(`${formatSimJointReport(report)}\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

function parseArgs(argv: string[]): { help: boolean; digitalHumanB: string | undefined } {
  let help = false;
  let digitalHumanB: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--digital-human-b") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--") || next.length === 0) {
        throw new Error("--digital-human-b 需要 digitalHumanId");
      }
      digitalHumanB = next;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg ?? ""}`);
  }
  return { help, digitalHumanB };
}

function helpText(): string {
  return [
    `用法: ${LIVE_STUB_ENV}=http://127.0.0.1:8787 npm run sim-joint -- [--digital-human-b <digitalHumanId>]`,
    "一次性 sim / API-only。OpenBot stub 在 8787，本命令在 127.0.0.1:8791 拉起 device-control，检查完就关掉。",
    "顺序: pair challenge → redeem → consent PKCE S256 → grants/exchange（同一 stub 必须能 GET 到 grant）→ bind → list/bind status → rebind（bindingVersion++）→ revoke → bind/sync 显示 revoked，旧 grant 不能再开会话。",
    "凭证名只看 openbot-vp staging.md：OPENBOT_STUB_SERVICE_USER、OPENBOT_STUB_SERVICE_PASSWORD、OPENBOT_STUB_CONSENT_USER、OPENBOT_STUB_CONSENT_PASSWORD。不要把口令写进仓库。",
    "另外要有 OPENBOT_DEVICE_DH_STUB_ID、OPENBOT_STUB_DEVICE_ID、OPENBOT_STUB_SERVICE_AUDIENCE、OPENBOT_STUB_REDIRECT_URI、OPENBOT_STUB_SCOPES、OPENBOT_STUB_AUTH_STATE、OPENBOT_STUB_CODE_VERIFIER。",
    "不要设置 OPENBOT_STUB_AUTHORIZATION_CODE。authorizationRef 只来自 exchange。",
    "未传 --digital-human-b 时，rebind 仍用数字人 A，只要求 bindingVersion 增加。",
    "每一项都是 sim / API-only。管理页面、真语音、摄像头、staging、真机、生产是 JOINT_PENDING。",
    "不调用 flash 或 massFlash。firmwareUrl 保持 null。grayRelease 与 realDeviceDelivery 保持 false。",
  ].join("\n");
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
