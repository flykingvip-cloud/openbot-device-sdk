import { ControlPlane } from "./control-plane.ts";
import { openStaging } from "./staging-db.ts";
import {
  XIAOZHI_VOICE_WS_ENV,
  resolveXiaozhiVoiceWsUrl,
  startXiaozhiOtaServer,
} from "./xiaozhi-ota.ts";

const DEFAULT_STATE = "var/xiaozhi-ota.sqlite";
/** Default distinct from device-control / lab-voice (both often 8791). */
const DEFAULT_LISTEN = "0.0.0.0:8002";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const voiceWsUrl = resolveXiaozhiVoiceWsUrl(process.env, args.voiceWsUrl);
  const store = openStaging(args.statePath);
  const plane = new ControlPlane({ store });
  void startXiaozhiOtaServer(plane, {
    host: args.host,
    port: args.port,
    voiceWsUrl,
  })
    .then((listening) => {
      process.stdout.write(
        [
          `小智 OTA: ${listening.url}/xiaozhi/ota/`,
          `状态: ${args.statePath}`,
          `下发 voice: ${voiceWsUrl}`,
          "POST|GET /xiaozhi/ota/  头 Device-Id 必填；已绑定则签发短时 token",
          "未绑定/已吊销仍返回 200 + activation，不返回 mqtt / firmware",
          "websocket.url 必须是设备可达地址，不要填 0.0.0.0 监听返回的 127.0.0.1",
          "注意：device-control 与 lab-voice 默认都是 8791，请错开端口",
          "与 lab-voice 联调请共用 --state（或 npm run claw4-lab）；拆开两个默认 sqlite 会导致 WS 401",
          "本进程与 lab ota-config（loopback LabDeviceConfig）并存，路径不同",
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

function parseArgs(argv: string[]): {
  statePath: string;
  host: string;
  port: number;
  voiceWsUrl?: string;
  help: boolean;
} {
  let statePath = DEFAULT_STATE;
  let listen = DEFAULT_LISTEN;
  let voiceWsUrl: string | undefined;
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
    if (arg === "--voice-ws") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--voice-ws 需要 ws:// 或 wss:// URL");
      }
      voiceWsUrl = next;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg ?? ""}`);
  }
  const parsed = parseListen(listen);
  const result: {
    statePath: string;
    host: string;
    port: number;
    voiceWsUrl?: string;
    help: boolean;
  } = { statePath, host: parsed.host, port: parsed.port, help };
  if (voiceWsUrl !== undefined) result.voiceWsUrl = voiceWsUrl;
  return result;
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
    throw new Error("--listen 主机无效");
  }
  return { host, port };
}

function helpText(): string {
  return [
    "用法: npm run xiaozhi-ota -- [--listen 0.0.0.0:8002] [--state 路径] [--voice-ws URL]",
    `  或设置环境变量 ${XIAOZHI_VOICE_WS_ENV}=ws://<设备可达主机>:8791`,
    "  小智/Metalio 固件 POST NVS ota_url，返回 websocket + server_time",
    "  已绑定设备：进程内 issueConnectionCredential 签发裸 token（无 Bearer 前缀）",
    "  未绑定：200 + activation 提示，不 500",
    "  禁止响应 mqtt / firmware 字段",
    "  默认监听 0.0.0.0:8002，与 lab ota-config(8790)、voice/device-control(8791) 错开",
    "  默认状态文件 var/xiaozhi-ota.sqlite（已 gitignore）",
  ].join("\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
