import { OPENBOT_CONTRACT_SHA, PREVIOUS_CONTRACT_SHA } from "../../contracts/src/index.ts";
import { ControlPlane } from "./control-plane.ts";
import { startLabOtaConfigServer } from "./ota-config.ts";
import { openStaging } from "./staging-db.ts";

const DEFAULT_STATE = "var/ota-config.sqlite";
const DEFAULT_LISTEN = "127.0.0.1:8790";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const store = openStaging(args.statePath);
  const plane = new ControlPlane({ store });
  const server = startLabOtaConfigServer(plane, { host: args.host, port: args.port });
  void server
    .then((listening) => {
      process.stdout.write(
        [
          `实验 OTA 配置: ${listening.url}`,
          `状态: ${args.statePath}`,
          `合约针: ${OPENBOT_CONTRACT_SHA}`,
          "GET /devices/{deviceId}/config",
          "未设置 OPENBOT_LAB_VOICE_WSS_URL 时，voice WSS 是 wss://lab.invalid/voice",
          "设置为本机 npm run voice 的 ws://127.0.0.1:端口 后，已绑定设备改用实验语音",
          "拒绝 api.tenclass.net",
          "firmwareUrl 保持 null。本进程不烧录。",
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
    "用法: npm run ota-config -- [--listen 127.0.0.1:8790] [--state 路径]",
    "  实验用配置 HTTP。设备可读取 voice WSS 占位、device API 前缀、bindingVersion 和短时 token",
    "  默认状态文件 var/ota-config.sqlite（已 gitignore）。以 .json 结尾时用 JSON",
    `  合约针 ${OPENBOT_CONTRACT_SHA}（openbot-vp main，PR #9 squash）`,
    `  已作废、不是 officialMergeSha: ${PREVIOUS_CONTRACT_SHA}`,
    "  token 只在已认领且已绑定、且未吊销时签发。未认领没有 token",
    "  firmwareUrl 固定 null。flash 与 massFlash 不在这里执行",
    "  不是生产 OTA，也不会把 api.tenclass.net 当作入口",
  ].join("\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
