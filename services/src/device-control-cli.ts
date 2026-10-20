import { serviceBasicFromEnv } from "../../contracts/src/index.ts";
import { ControlPlane } from "./control-plane.ts";
import { startDeviceControlServer } from "./device-control.ts";
import { openStaging } from "./staging-db.ts";

const DEFAULT_STATE = "var/device-control.sqlite";
const DEFAULT_LISTEN = "127.0.0.1:8791";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (serviceBasicFromEnv(process.env) === undefined) {
    throw new Error("需要 OPENBOT_STUB_SERVICE_USER 和 OPENBOT_STUB_SERVICE_PASSWORD");
  }
  const store = openStaging(args.statePath);
  const plane = new ControlPlane({ store });
  void startDeviceControlServer(plane, { host: args.host, port: args.port })
    .then((listening) => {
      process.stdout.write(
        [
          `设备控制 v1: ${listening.url}/api/device-platform/v1`,
          `状态: ${args.statePath}`,
          "这是已冻结的 v1 联合契约（maturity: v1-frozen），不是灰度，也不是真机交付",
          "只接受 service Basic。浏览器声明的 userId / tenantId / digitalHumanId 不会被采信",
          "配对挑战只在本前缀。不要把 pairChallenge / pairingCode 放进 /api/integrations/v1",
          "apply bind 只接受 OpenBot exchange 之后的 authorizationRef，本进程不铸造该字段",
          "flash 与 massFlash 不在这里执行。firmwareUrl 保持 null",
          "",
        ].join("\n"),
      );
    })
    .catch((error: unknown) => {
      store.close();
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

function parseArgs(argv: string[]): { statePath: string; host: string; port: number; help: boolean } {
  let statePath = DEFAULT_STATE;
  let listen = DEFAULT_LISTEN;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--state") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--state 需要本地路径");
      }
      statePath = next;
      index += 1;
      continue;
    }
    if (arg === "--listen") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--listen 需要 host:port");
      }
      listen = next;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg ?? ""}`);
  }
  const parsed = parseListen(listen);
  return { statePath, host: parsed.host, port: parsed.port, help };
}

function parseListen(value: string): { host: string; port: number } {
  const split = value.lastIndexOf(":");
  if (split <= 0 || split === value.length - 1) {
    throw new Error("--listen 需要 host:port");
  }
  const host = value.slice(0, split);
  const port = Number(value.slice(split + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--listen 端口无效");
  }
  if (host.length === 0 || host.includes("://")) {
    throw new Error("--listen 主机必须是本机地址");
  }
  return { host, port };
}

function helpText(): string {
  return [
    "用法: npm run device-control -- [--listen 127.0.0.1:8791] [--state 路径]",
    "  OpenBot 服务客户端使用的设备控制 HTTP。前缀是 /api/device-platform/v1",
    "  不是 /api/integrations/v1，也不是实验 OTA 配置进程",
    "  认证: OPENBOT_STUB_SERVICE_USER 与 OPENBOT_STUB_SERVICE_PASSWORD",
    "  绑定和状态同步还要能读到 OpenBot grant（OPENBOT_DEVICE_DH_STUB_URL）",
    "  默认状态文件 var/device-control.sqlite（已 gitignore）。以 .json 结尾时用 JSON",
    "  只绑定 loopback。flash 与 massFlash 不执行",
    "  这是已冻结的 v1 联合契约（maturity: v1-frozen），不是灰度，也不是真机交付",
  ].join("\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
