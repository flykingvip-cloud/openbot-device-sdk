# Loopback live stub

消费者对着本机 stub 说话。默认地址是 `http://127.0.0.1:8787`。`GET /healthz` 在这个源的根上，不在 `/api/integrations/v1` 下面。能力路径都在这个前缀下。

这不是灰度，也不是真机。本地 B0–B5 stand-in 还在。`firmwareUrl` 仍是 null。`flash()` 和 `massFlash()` 仍然失败。

## 怎么跑

先在本机把 openbot-vp 的 loopback stub 开在 8787，然后：

```bash
OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787 npm run live-stub
```

未设置 `OPENBOT_DEVICE_DH_STUB_URL` 时，命令只打印用法，不访问网络。地址必须是 `127.0.0.1`、`localhost` 或 `::1`。带用户名口令的 URL 会被拒绝，也不会连 `api.tenclass.net`。

只设了 URL 时，探测 `GET /healthz`。下面这些不会调用：同意码、兑换、吊销、重绑、设备能力 PUT、会话、运行 SSE、`flash`、`massFlash`。

## 样例客户端

口令写在 openbot-vp 合约针 `bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a` 的 `docs/integrations/device-digital-human/staging.md`。本环境访问该仓库得到 404，所以这里不复制、也不编造用户名和口令。OpenAPI 只声明了角色：

| 角色 | 方案 | 环境变量 |
|---|---|---|
| consent | HTTP Basic `consentBasic` | `OPENBOT_STUB_CONSENT_USER`、`OPENBOT_STUB_CONSENT_PASSWORD` |
| service | HTTP Basic `serviceBasic` | `OPENBOT_STUB_SERVICE_USER`、`OPENBOT_STUB_SERVICE_PASSWORD` |
| grant | 头 `X-OpenBot-Grant-Credential` | `OPENBOT_STUB_GRANT_CREDENTIAL` |

从那份 staging.md 抄进环境变量。service 和 grant 必须一起设置。只设置一半会失败，不会发出半套凭证。未设置时，数字人 GET 和实验摄像头 live 模式跳过。

数字人：

```bash
OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787 \
OPENBOT_STUB_SERVICE_USER=... \
OPENBOT_STUB_SERVICE_PASSWORD=... \
OPENBOT_STUB_GRANT_CREDENTIAL=... \
OPENBOT_DEVICE_DH_STUB_ID=dh-stub \
npm run live-stub
```

`GET /api/integrations/v1/digital-humans/{digitalHumanId}` 带 service Basic 和 grant 头。`npm test` 里对应的 live 用例在凭证未设置时跳过。

## B0–B5

| 项 | loopback 上的对应路径 | 这次探测 |
|---|---|---|
| 健康 | `GET /healthz`（根） | 只要 URL 设了就请求 |
| B0 | `PUT /api/integrations/v1/grants/{authorizationRef}/device-capabilities` | 不调用。本地 stand-in 仍是 `GET /v1/device/capabilities` |
| B1 | `GET /api/integrations/v1/digital-humans/{digitalHumanId}` | 凭证齐全才请求 |
| B2 | `POST /api/integrations/v1/conversations` 以及 runs | 不调用。本地会话 stand-in 不变 |
| B3 | `POST /api/integrations/v1/device-tool-requests/{requestId}/result` | 仅 `--camera` |
| B4 | `POST /api/integrations/v1/media/upload-tickets`，然后 `PUT /api/integrations/v1/media/uploads/{ticket}` | 仅 `--camera`。PUT 只靠票据，不带头里的 grant |
| B5 | 不在这份 OpenAPI 里 | 不调用。实验 OTA 仍是 `firmwareUrl: null` |

## 实验摄像头

仍是 1×1 PNG 夹具，不是 OV2710。

```bash
OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787 \
OPENBOT_STUB_SERVICE_USER=... \
OPENBOT_STUB_SERVICE_PASSWORD=... \
OPENBOT_STUB_GRANT_CREDENTIAL=... \
OPENBOT_STUB_AUTHORIZATION_REF=... \
OPENBOT_STUB_BINDING_VERSION=1 \
OPENBOT_STUB_DEVICE_ID=... \
npm run live-stub -- --camera
```

票据 POST 和结果 POST 带 service Basic 与 grant。PUT 不带这两项。没设 URL 时，实验摄像头仍走本地 stand-in。

## 数字人会话

当前针是 PR #10 的 `bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a`。`41b75612…` 已作废。路径和 SSE 事件名仍与入库 OpenAPI 一致，`routesAligned` 保持 true。这只是静态对齐，不是端到端联调通过。B2–B5 仍是本地 stand-in。

数字人配置要带 `gatewayAgentId`（`OPENBOT_DEVICE_DH_GATEWAY_AGENT_ID`，实验配置里没设置则为 null）。默认代理会话键是 `device-dh:<digitalHumanId>:<conversationId>`。只有 `OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE=1` 时才改用 UI 会话键。冻结字段名不变。本地 B2 `sessionId` 不是这把键。
