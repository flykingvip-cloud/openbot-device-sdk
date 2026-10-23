# Claw4 gateway upload 对接（A6 · SDK 侧）

`POST /api/v1/upload`、`GET /api/v1/conversation/{id}/messages`、以及预留的 `POST /api/v1/record/upload` **由 OpenBot gateway / integrations stub 适配层提供**（方案 B1）。本 SDK **不实现**这些路由，也 **不得**把它们写进冻结的 device-control v1（`/api/device-platform/v1`）。

权威契约与路由说明在 openbot-vp：

- 路径：`docs/integrations/device-digital-human/claw4-firmware-http-compat.md`
- 合入：openbot-vp PR #53（B1），tip `ed9d63be`（以 B 仓文档为准；本仓只给对接示例）

本页只写 SDK / 固件怎么对 stub 发请求，以及与 lab-voice / device-control 的**双命令**联调姿势。`npm run sim` **故意不吞**语音 / upload 验收，以免污染 v1-frozen 证据链。

## 边界（硬）

| 面 | 有没有 `/api/v1/upload` |
|---|---|
| OpenBot stub / gateway 适配层 | 有（B 主责） |
| 本 SDK device-control | **没有**，也不进 OpenAPI |
| `npm run sim` | **没有**；控制面证据链保持原样 |
| `npm run voice-joint` | 只打 stub 上的 compat 路由（可选再探 device-control health） |

冻结针不变：`OPENBOT_CONTRACT_SHA`、`contracts/device-platform/device-control.openapi.yaml`。

## 主路径：loopback stub `:8787`

联调 / smoke **以 stub `http://127.0.0.1:8787` 为主路径**。B 侧 smoke：带 `?transcript=` 的 upload 在 stub 上 PASS。

gateway 口（常见 `:18789`）在未注入 `DeviceDhService` 时，对 `/api/v1/*` 会 **503**。那不是 SDK bug，也不是「主路径失败」——文档与 harness 默认只认 stub 8787。

能力前缀仍是 stub 根上的 `/api/v1/*`（compat），与 `/api/integrations/v1` 共用同一会话存储；相机 JPEG/PNG 仍走 media upload-ticket，**不要**混进 WAV upload。

## 鉴权（与 integrations service grant 一致）

三件套缺一不可；**不是** device-control 的 pair / local token：

1. `Authorization: Basic <serviceClientId:secret>` — integrations `serviceBasic`
2. `X-OpenBot-Grant-Credential: <grant exchange 凭证>`
3. `X-Device-Id: <external device id>` — **必须等于** `grant.deviceId`；否则 `BINDING_MISMATCH`

撤销后 upload / messages / record/upload stub 立即 `AUTH_REVOKED`（HTTP 401）。口令只从 openbot-vp 合约针对应的 `staging.md` 抄进环境，**不写进本仓库**。

环境变量（与 live-stub / sim-joint 同名）：

| 名字 | 用途 |
|---|---|
| `OPENBOT_DEVICE_DH_STUB_URL` | 例 `http://127.0.0.1:8787` |
| `OPENBOT_STUB_SERVICE_USER` / `OPENBOT_STUB_SERVICE_PASSWORD` | service Basic |
| `OPENBOT_STUB_GRANT_CREDENTIAL` | grant 头 |
| `OPENBOT_STUB_DEVICE_ID` | `X-Device-Id`（= grant.deviceId） |

可选：`OPENBOT_VOICE_JOINT_TRANSCRIPT`（默认 `claw4-upload-smoke`）、`OPENBOT_VOICE_JOINT_CONTROL_URL`（例 `http://127.0.0.1:8791`，只探 DC health）。

## `data.text` 语义

成功响应：

```json
{ "code": 0, "data": { "text": "…", "conversationId": "conv_…" } }
```

这里的 **`data.text` 是 ASR / 透传文本**（query `transcript=` 或头 `X-Transcript-Text`，或 stub 标签文本），**不是**助手 `assistant.final`。助手气泡请再 `GET /api/v1/conversation/{id}/messages`（或 integrations 读模型）。query `transcript=` 与头同时存在时 **query 优先**（UTF-8 友好）。

`POST /api/v1/record/upload` 为 **预留 stub**（同形成功信封；body 语义后期），录音卡路径另见 [docs/a5-device-capability-matrix.md](../a5-device-capability-matrix.md)。

## 示例 curl（stub 8787）

最小 WAV + 透传 transcript（不依赖本机 FunASR）：

```bash
# 口令从 openbot-vp staging.md 抄；下面 ... 是占位，不是可用口令
STUB=http://127.0.0.1:8787
# 44 字节空 PCM WAV 头 + 0 样本亦可；或用 examples/claw4-upload-curl.sh
printf 'RIFF....WAVEfmt ....' > /tmp/claw4-smoke.wav   # 请改用脚本生成合法 WAV

curl -sS -u "$OPENBOT_STUB_SERVICE_USER:$OPENBOT_STUB_SERVICE_PASSWORD" \
  -H "X-OpenBot-Grant-Credential: $OPENBOT_STUB_GRANT_CREDENTIAL" \
  -H "X-Device-Id: $OPENBOT_STUB_DEVICE_ID" \
  -H 'Content-Type: audio/wav' \
  --data-binary @/tmp/claw4-smoke.wav \
  "$STUB/api/v1/upload?transcript=hello-from-sdk"

# 记下 data.conversationId 后：
curl -sS -u "$OPENBOT_STUB_SERVICE_USER:$OPENBOT_STUB_SERVICE_PASSWORD" \
  -H "X-OpenBot-Grant-Credential: $OPENBOT_STUB_GRANT_CREDENTIAL" \
  -H "X-Device-Id: $OPENBOT_STUB_DEVICE_ID" \
  "$STUB/api/v1/conversation/<conversationId>/messages"
```

可执行包装：[`examples/claw4-upload-curl.sh`](../../examples/claw4-upload-curl.sh)。Node harness：`npm run voice-joint`（凭证缺失时跳过，跳过不是通过）。

## 联合复现：双命令（voice + control），不进 `npm run sim`

控制面与语音 / upload 分进程，避免把 upload 验收塞进 `npm run sim`：

```bash
# 终端 A — OpenBot stub（openbot-vp listenDeviceDh）在 8787
# 终端 B — 冻结 device-control（可选，只证控制面仍独立）
npm run device-control -- --listen 127.0.0.1:8791

# 终端 C — lab 语音 WS（可选；Provider / 打断另见 docs/lab-voice.md）
npm run voice -- --listen 127.0.0.1:8792 --state var/lab-voice.sqlite

# 终端 D — claw4 upload+messages smoke（本切片 harness）
OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787 \
OPENBOT_STUB_SERVICE_USER=... \
OPENBOT_STUB_SERVICE_PASSWORD=... \
OPENBOT_STUB_GRANT_CREDENTIAL=... \
OPENBOT_STUB_DEVICE_ID=... \
OPENBOT_VOICE_JOINT_CONTROL_URL=http://127.0.0.1:8791 \
npm run voice-joint
```

`voice-joint` 会：

1. `GET` stub `/healthz`
2. `POST /api/v1/upload?transcript=…`（`audio/wav`）
3. 断言 `code===0` 且 `data.text` 等于透传 transcript（ASR/passthrough，非 assistant final）
4. `GET /api/v1/conversation/{id}/messages`
5. 若设置了 `OPENBOT_VOICE_JOINT_CONTROL_URL`，再 `GET …/api/device-platform/v1/health`（maturity 仍为 `v1-frozen`）
6. 打印 `JOINT_PENDING: UI、staging、real-device、production`；**不**调用 flash / massFlash；**不**改 `npm run sim`

## 不做

- 不在本仓实现 gateway `/api/v1/*`
- 不改 device-control OpenAPI / 路由 / 冻结字段
- 不把 upload 步骤并进 `npm run sim` 或扩大 sim-joint 控制面证据链
- 不连接 `api.tenclass.net`；不硬编码 FunASR / EdgeTTS
