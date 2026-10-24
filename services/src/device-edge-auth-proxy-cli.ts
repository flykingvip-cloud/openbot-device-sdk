import { OPENBOT_CONTRACT_SHA } from "../../contracts/src/index.ts";
import {
  DEVICE_EDGE_AUTH_PROXY_ENV,
  DEVICE_EDGE_PROXY_PREFIX,
  assertLoopbackUpstreamUrl,
  createLabDeviceEdgeAuthProxyFromEnv,
  startDeviceEdgeAuthProxyServer,
} from "./device-edge-auth-proxy.ts";

const DEFAULT_LISTEN = "127.0.0.1:8792";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  if (args.smoke) {
    void runSmoke(args).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
    return;
  }

  const proxy = createLabDeviceEdgeAuthProxyFromEnv(process.env);
  const upstreamRaw = process.env[DEVICE_EDGE_AUTH_PROXY_ENV.upstreamUrl];
  const upstreamUrl =
    upstreamRaw !== undefined && upstreamRaw.length > 0
      ? assertLoopbackUpstreamUrl(upstreamRaw).toString()
      : undefined;

  void startDeviceEdgeAuthProxyServer({
    host: args.host,
    port: args.port,
    proxy,
    ...(upstreamUrl !== undefined ? { upstreamUrl } : {}),
  })
    .then((listening) => {
      process.stdout.write(
        [
          `设备边缘鉴权代理: ${listening.url}`,
          `模式: ${listening.mode}`,
          `合约针: ${OPENBOT_CONTRACT_SHA}`,
          `健康: GET ${listening.url}/healthz`,
          `代理: ${listening.url}${DEVICE_EDGE_PROXY_PREFIX}/…`,
          "设备跳: Authorization: Bearer <deviceToken> + X-Device-Id",
          "成功后边缘附带 service Basic + X-OpenBot-Grant-Credential + X-Device-Id",
          "verify 失败返回 401，且不接触 OpenBot / upstream",
          "固件不得烧平台 service Basic；口令只从环境注入边缘",
          upstreamUrl === undefined
            ? `未设置 ${DEVICE_EDGE_AUTH_PROXY_ENV.upstreamUrl} → 内嵌 mock upstream（冒烟）`
            : `upstream: ${upstreamUrl}`,
          "",
        ].join("\n"),
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

async function runSmoke(args: { host: string; port: number }): Promise<void> {
  process.env[DEVICE_EDGE_AUTH_PROXY_ENV.labTokens] ??= "dev-edge-lab:ctok_edge_lab";
  const proxy = createLabDeviceEdgeAuthProxyFromEnv(process.env);
  const listening = await startDeviceEdgeAuthProxyServer({
    host: args.host,
    port: args.port,
    proxy,
  });

  try {
    const bad = await fetch(`${listening.url}${DEVICE_EDGE_PROXY_PREFIX}/healthz-echo`, {
      method: "GET",
      headers: {
        Authorization: "Bearer wrong-token",
        "X-Device-Id": "dev-edge-lab",
      },
    });
    const good = await fetch(`${listening.url}${DEVICE_EDGE_PROXY_PREFIX}/healthz-echo`, {
      method: "GET",
      headers: {
        Authorization: "Bearer ctok_edge_lab",
        "X-Device-Id": "dev-edge-lab",
      },
    });
    const goodJson = (await good.json()) as {
      ok?: boolean;
      upstream?: {
        receivedAuthorization?: boolean;
        receivedGrant?: boolean;
        receivedDeviceId?: boolean;
      };
    };
    const hit = listening.lastUpstreamHit();
    const lines = [
      `设备边缘鉴权冒烟: ${listening.url}`,
      `合约针: ${OPENBOT_CONTRACT_SHA}`,
      `坏 token → HTTP ${bad.status}（期望 401；upstream hits 在坏请求后应为空或未被该次命中）`,
      `好 token → HTTP ${good.status}`,
      `mock upstream 三头齐全: auth=${String(goodJson.upstream?.receivedAuthorization)} grant=${String(goodJson.upstream?.receivedGrant)} deviceId=${String(goodJson.upstream?.receivedDeviceId)}`,
      hit === undefined
        ? "lastUpstreamHit: none"
        : `lastUpstreamHit path=${hit.path} hasBasic=${String(hit.headers.Authorization?.startsWith("Basic ") ?? false)}`,
      bad.status === 401 &&
        good.status === 200 &&
        goodJson.upstream?.receivedAuthorization === true &&
        goodJson.upstream?.receivedGrant === true &&
        goodJson.upstream?.receivedDeviceId === true
        ? "SMOKE_OK"
        : "SMOKE_FAIL",
      "",
    ];
    process.stdout.write(lines.join("\n"));
    if (bad.status !== 401 || good.status !== 200 || goodJson.upstream?.receivedAuthorization !== true) {
      process.exitCode = 1;
    }
  } finally {
    await listening.close();
  }
}

function parseArgs(argv: string[]): {
  host: string;
  port: number;
  help: boolean;
  smoke: boolean;
} {
  let listen = process.env[DEVICE_EDGE_AUTH_PROXY_ENV.listen] ?? DEFAULT_LISTEN;
  let help = false;
  let smoke = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--smoke") {
      smoke = true;
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
  return { host: parsed.host, port: parsed.port, help, smoke };
}

function parseListen(value: string): { host: string; port: number } {
  const split = value.lastIndexOf(":");
  if (split <= 0 || split === value.length - 1) {
    throw new Error("--listen 需要 host:port");
  }
  const host = value.slice(0, split);
  const port = Number(value.slice(split + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--listen 端口无效");
  }
  return { host, port };
}

function helpText(): string {
  return [
    "用法:",
    "  npm run device-edge-auth -- [--listen 127.0.0.1:8792]",
    "  npm run device-edge-auth -- --smoke",
    "",
    "两跳: device --(Bearer deviceToken + X-Device-Id)--> SDK edge --(Basic + grant + X-Device-Id)--> OpenBot",
    "固件不得烧平台 service Basic。",
    "",
    "环境变量:",
    `  ${DEVICE_EDGE_AUTH_PROXY_ENV.labTokens}=deviceId:token[,…]  实验室设备票（默认 dev-edge-lab:ctok_edge_lab）`,
    `  ${DEVICE_EDGE_AUTH_PROXY_ENV.serviceUser}/${DEVICE_EDGE_AUTH_PROXY_ENV.servicePassword}/${DEVICE_EDGE_AUTH_PROXY_ENV.grantCredential}`,
    "    边缘持有的 service 凭证；未设时冒烟用 lab-edge-svc 占位（非平台口令）",
    `  ${DEVICE_EDGE_AUTH_PROXY_ENV.upstreamUrl}=http://127.0.0.1:8787  可选；未设则内嵌 mock upstream`,
    `  ${DEVICE_EDGE_AUTH_PROXY_ENV.listen}=127.0.0.1:8792`,
    "",
    "不 mint grants；不改 ControlPlane / device-control OpenAPI。",
  ].join("\n");
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
