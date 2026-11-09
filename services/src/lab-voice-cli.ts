import { METALIO_DOWNLINK_SAMPLE_RATE } from "../../adapters/metalio/src/index.ts";
import { createVoiceProvidersFromEnv } from "../../adapters/voice/src/index.ts";
import { OPENBOT_CONTRACT_SHA } from "../../contracts/src/index.ts";
import { ControlPlane } from "./control-plane.ts";
import { LAB_VOICE_WSS_ENV } from "./ota-config.ts";
import { startLabVoiceServer } from "./lab-voice.ts";
import { openStaging } from "./staging-db.ts";

const DEFAULT_STATE = "var/lab-voice.sqlite";
const DEFAULT_LISTEN = "127.0.0.1:8791";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const store = openStaging(args.statePath);
  const plane = new ControlPlane({ store });
  const providers = createVoiceProvidersFromEnv();
  void startLabVoiceServer(plane, {
    host: args.host,
    port: args.port,
    asrProvider: providers.asr,
    ttsProvider: providers.tts,
    downlinkSampleRate: METALIO_DOWNLINK_SAMPLE_RATE,
  })
    .then((listening) => {
      process.stdout.write(
        [
          `实验语音: ${listening.url}`,
          `状态: ${args.statePath}`,
          `合约针: ${OPENBOT_CONTRACT_SHA}`,
          `让实验配置改用这个地址: ${LAB_VOICE_WSS_ENV}=${listening.url}`,
          `hello audio_params.sample_rate: ${METALIO_DOWNLINK_SAMPLE_RATE}`,
          `ASR: ${providers.asrKind}`,
          `TTS: ${providers.ttsKind}`,
          "只接受已绑定且未吊销的短时 token。hello 使用 Metalio 的 websocket。",
          "TTS 字节默认是 OB-OPUS-PLACEHOLDER。mock 打断残留 ≤2400 ms；真 TtsProvider 打断清队列（queueCleared）。",
          "OPENBOT_ASR_PROVIDER=reference-http 且设置了 OPENBOT_ASR_HTTP_URL 时，listen.stop 会 POST 该 ASR。",
          "不是生产 ASR/TTS，也不会连接 api.tenclass.net。",
          "失败轮次写到 stderr，前缀 VOICE-DIAG（不含 token / grant）。",
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
    "用法: npm run voice -- [--listen 127.0.0.1:8791] [--state 路径]",
    "  实验用语音 WebSocket。默认只监听 127.0.0.1:8791",
    "  默认状态文件 var/lab-voice.sqlite（已 gitignore）。以 .json 结尾时用 JSON",
    `  合约针 ${OPENBOT_CONTRACT_SHA}`,
    `  配置服务读取 ${LAB_VOICE_WSS_ENV} 后，已绑定设备的 voiceWssUrl 改用该地址`,
    "  未设置时实验配置仍是 wss://lab.invalid/voice",
    "  本地模拟要显式设置 OPENBOT_DEVICE_DH_TEST_MODE=1，并标明 dialogue: sim",
    "  没设 TEST_MODE、也没配 stub 时，不会把 ASR 文本播成助手话",
    "  设置 stub URL、service Basic 和 grant 后，助手话只来自 assistant.visible / assistant.final",
    "  ASR/TTS 通过环境变量注入（默认 mock）；reference-http 需要对应的 *_HTTP_URL",
    `  服务端 hello sample_rate 为 ${METALIO_DOWNLINK_SAMPLE_RATE}（对齐 Claw4 扬声器）`,
    "  不连接 api.tenclass.net，也不烧录固件",
  ].join("\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
