import { OPENBOT_CONTRACT_SHA } from "../../contracts/src/index.ts";
import { ensureLabDeviceBound } from "./claw4-lab.ts";
import { ControlPlane } from "./control-plane.ts";
import { createVoiceProvidersFromEnv } from "../../adapters/voice/src/index.ts";
import { startLabVoiceServer } from "./lab-voice.ts";
import { openStaging } from "./staging-db.ts";
import {
  XIAOZHI_VOICE_WS_ENV,
  resolveXiaozhiVoiceWsUrl,
  startXiaozhiOtaServer,
} from "./xiaozhi-ota.ts";

/** Shared state so OTA-issued tokens are accepted by lab-voice. */
const DEFAULT_STATE = "var/claw4-lab.sqlite";
const DEFAULT_OTA_LISTEN = "0.0.0.0:8002";
const DEFAULT_VOICE_LISTEN = "0.0.0.0:8791";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const voiceWsUrl = resolveXiaozhiVoiceWsUrl(process.env, args.voiceWsUrl);
  const store = openStaging(args.statePath);
  const plane = new ControlPlane({ store });

  if (args.bindDeviceId !== undefined) {
    const result = ensureLabDeviceBound(plane, args.bindDeviceId);
    process.stdout.write(
      result.created
        ? `lab bind 新建: ${args.bindDeviceId} authorizationRef=${result.authorizationRef} v${result.bindingVersion}\n`
        : `lab bind 已存在: ${args.bindDeviceId} authorizationRef=${result.authorizationRef} v${result.bindingVersion}\n`,
    );
  }

  const voiceProviders = createVoiceProvidersFromEnv({ env: process.env });
  void Promise.all([
    startLabVoiceServer(plane, {
      host: args.voiceHost,
      port: args.voicePort,
      asrProvider: voiceProviders.asr,
      ttsProvider: voiceProviders.tts,
    }),
    startXiaozhiOtaServer(plane, {
      host: args.otaHost,
      port: args.otaPort,
      voiceWsUrl,
    }),
  ])
    .then(([voice, ota]) => {
      process.stdout.write(
        [
          `Claw4 lab joint（同一 ControlPlane）`,
          `ASR/TTS: ${voiceProviders.asrKind} / ${voiceProviders.ttsKind}`,
          `状态: ${args.statePath}`,
          `合约针: ${OPENBOT_CONTRACT_SHA}`,
          `语音监听: ${voice.url}  （设备应连 advertise: ${voiceWsUrl}）`,
          `OTA: ${ota.url}/xiaozhi/ota/`,
          "设备 NVS wifi/ota_url ← 上面 OTA URL（本固件 tip 无「服务器地址」UI，用 claw4-set-ota-url.py）",
          "OTA 签发的 token 与 voice 校验共用本进程 store；勿拆开两个默认 sqlite",
          "device-control 默认也是 8791，联调时不要同时抢端口",
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
  otaHost: string;
  otaPort: number;
  voiceHost: string;
  voicePort: number;
  voiceWsUrl?: string;
  bindDeviceId?: string;
  help: boolean;
} {
  let statePath = DEFAULT_STATE;
  let otaListen = DEFAULT_OTA_LISTEN;
  let voiceListen = DEFAULT_VOICE_LISTEN;
  let voiceWsUrl: string | undefined;
  let bindDeviceId: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--state") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--state 需要本地路径");
      statePath = next;
      index += 1;
      continue;
    }
    if (arg === "--ota-listen") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--ota-listen 需要 host:port");
      otaListen = next;
      index += 1;
      continue;
    }
    if (arg === "--voice-listen") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--voice-listen 需要 host:port");
      voiceListen = next;
      index += 1;
      continue;
    }
    if (arg === "--voice-ws") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--voice-ws 需要 ws:// 或 wss://");
      voiceWsUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--bind-device") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--bind-device 需要 Device-Id / MAC");
      bindDeviceId = next;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg ?? ""}`);
  }
  const ota = parseListen(otaListen);
  const voice = parseListen(voiceListen);
  const result: {
    statePath: string;
    otaHost: string;
    otaPort: number;
    voiceHost: string;
    voicePort: number;
    voiceWsUrl?: string;
    bindDeviceId?: string;
    help: boolean;
  } = {
    statePath,
    otaHost: ota.host,
    otaPort: ota.port,
    voiceHost: voice.host,
    voicePort: voice.port,
    help,
  };
  if (voiceWsUrl !== undefined) result.voiceWsUrl = voiceWsUrl;
  if (bindDeviceId !== undefined) result.bindDeviceId = bindDeviceId;
  return result;
}

function parseListen(value: string): { host: string; port: number } {
  const split = value.lastIndexOf(":");
  if (split <= 0 || split === value.length - 1) throw new Error("listen 需要 host:port");
  const host = value.slice(0, split);
  const port = Number(value.slice(split + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("listen 端口无效");
  if (host.length === 0 || host.includes("://")) throw new Error("listen 主机无效");
  return { host, port };
}

function helpText(): string {
  return [
    "用法: npm run claw4-lab -- --voice-ws ws://<LAN-IP>:8791 [--bind-device 80:f1:b2:d2:eb:fb]",
    "  同一进程启动 lab-voice + 小智 OTA，共享 ControlPlane / sqlite",
        `  默认 OTA ${DEFAULT_OTA_LISTEN}，voice ${DEFAULT_VOICE_LISTEN}，状态 ${DEFAULT_STATE}`,
        `  也可用环境变量 ${XIAOZHI_VOICE_WS_ENV}`,
    "  --bind-device：lab 认领+绑定（非生产 grant 路径），真机联调前置",
    "  固件 tip 3d12a6ea 无「服务器地址」UI；用 NVS 写 wifi/ota_url 后断电重启",
    "  设备与本机须同局域网；确认网络切换为 WiFi 而非 4G",
    "  WS 握手须带 Client-Id（UUID）；缺了 lab-voice 会 400",
    "  TTS 默认 mock 占位；可设 OPENBOT_TTS_PROVIDER=proportional-silence|reference-http（后者要 OPENBOT_TTS_HTTP_URL）",
    "  无 live stub 时设 OPENBOT_DEVICE_DH_TEST_MODE=1 才会 sim 回复并走 TTS",
    "  联调勿对已绑定 MAC 乱 curl OTA，会顶掉设备 token；唤醒默认关，须点进「聊天」App",
  ].join("\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
