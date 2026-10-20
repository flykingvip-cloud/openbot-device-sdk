import { DeviceControl, startDeviceControlServer } from "./device-control.ts";

const DEFAULT_LISTEN = "127.0.0.1:8792";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const clientId = process.env.OPENBOT_DEVICE_CONTROL_SERVICE_USER;
  const secret = process.env.OPENBOT_DEVICE_CONTROL_SERVICE_PASSWORD;
  if (clientId === undefined || secret === undefined || clientId.length === 0 || secret.length < 16) {
    throw new Error("OPENBOT_DEVICE_CONTROL_SERVICE_USER 和至少 16 字符的 OPENBOT_DEVICE_CONTROL_SERVICE_PASSWORD 必须一起设置");
  }
  const control = new DeviceControl({ clients: [{ clientId, secret }] });
  void startDeviceControlServer(control, { host: args.host, port: args.port }).then((listening) => {
    process.stdout.write(
      [
        `设备控制: ${listening.url}/api/device-control/v1`,
        "只监听 loopback。服务端 Basic 是调用方，不接受浏览器里的 user/tenant/digitalHumanId。",
        "三条草稿条目: device-control.discover、device-control.pair、device-control.control",
        "纵向连接器在草稿 PR #10，本进程不调用它。",
        "firmwareUrl 保持 null。不烧录，也不批量刷机。",
        "",
      ].join("\n"),
    );
  });
}

function helpText(): string {
  return [
    "用法: npm run device-control -- [--listen 127.0.0.1:8792]",
    "  实验用设备控制 HTTP。默认只监听 127.0.0.1:8792",
    "  鉴权: HTTP Basic，OPENBOT_DEVICE_CONTROL_SERVICE_USER / PASSWORD",
    "  密码至少 16 字符。调用方是服务客户端，不是浏览器用户、租户或数字人",
    "  GET /api/device-control/v1/health",
    "  GET /api/device-control/v1/capabilities",
    "  POST /api/device-control/v1/pair-challenges",
    "  POST /api/device-control/v1/pair-challenges/{challengeId}/verify",
    "  GET /api/device-control/v1/devices",
    "  POST /api/device-control/v1/devices/{deviceId}/binding",
    "  POST /api/device-control/v1/devices/{deviceId}/revoke",
    "  POST /api/device-control/v1/devices/{deviceId}/status",
    "  三条草稿条目给 OpenBot「设备与硬件」: 设备发现、设备配对、绑定与状态",
    "  配对挑战属于设备平台，不是 OpenBot 契约字段",
    "  纵向连接器在草稿 PR #10，本命令不依赖那份未合并代码",
    "  不连接 api.tenclass.net，也不烧录固件",
  ].join("\n");
}

function parseArgs(argv: string[]): { help: boolean; host: string; port: number } {
  let host = "127.0.0.1";
  let port = 8792;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, host, port };
    }
    if (arg === "--listen") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--listen 需要主机:端口");
      }
      const split = value.lastIndexOf(":");
      if (split <= 0) {
        throw new Error("--listen 需要主机:端口");
      }
      host = value.slice(0, split);
      port = Number(value.slice(split + 1));
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("--listen 端口无效");
      }
      index += 1;
      continue;
    }
    throw new Error(`未知参数 ${arg ?? ""}`);
  }
  if (host.length === 0) {
    throw new Error("--listen 主机必须是本机地址");
  }
  return { help: false, host, port };
}

void DEFAULT_LISTEN;

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
