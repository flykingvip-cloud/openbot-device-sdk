# 实验 OTA 配置 HTTP

这是给设备和模拟器读取的本机配置服务。它不是固件烧录，也不改生产 OTA 主机。它也不是 OpenBot 的 grants / conversations / runs 服务。

```bash
npm run ota-config -- --listen 127.0.0.1:8790 --state var/ota-config.sqlite
npm run ota-config -- --help
```

`--state` 以 `.json` 结尾时用 JSON，否则用 sqlite。默认文件 `var/ota-config.sqlite` 已在 `.gitignore` 里。短时 token 只写在状态文件和已核验的凭证响应里，不要提交。

默认只绑定 `127.0.0.1`。`0.0.0.0`、`::` 和其他非 loopback 主机会被拒绝。在有真实设备身份之前，不要把这个进程绑到可被别的机器访问的地址。

## 本进程实际提供的接口

- `GET /healthz`：本进程健康检查。`firmwareUrl` 为 null。
- `GET /devices/{deviceId}/config`：公开配置。只有非敏感 URL 和配对提示。
- `POST /devices/{deviceId}/credentials`：签发 token。必须带已核销的认领码（头 `X-OpenBot-Device-Proof`，或 JSON `claimCode`）。只知道 `deviceId` 不会签发。
- `GET /devices/{deviceId}/credentials`：读取当前凭证。必须带 `Authorization: Bearer`，并且 token 未过期、未吊销、设备和 `bindingVersion` 仍匹配。
- `POST /devices/{deviceId}/credentials/refresh`：轮换 token。必须出示当前 token。过期 token 可以刷新，吊销后不行。不访问网络。

公开配置里没有这些字段：`token`、`tokenExpiresAtMs`、`authorizationRef`、`bindingVersion`、`digitalHumanId`、`gatewayAgentId`、`agentSessionForce`。它们只出现在凭证响应里。

本进程不实现、也不在配置里广告这些路径：

- grants
- conversations
- runs
- `/api/integrations/v1` 下的其它 OpenBot 路由

`GET /api/integrations/v1/...` 在这个进程上是 404。

## 公开配置字段

- `contractSha`：`d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f`
- `routesAligned`：true。这只表示已入库 OpenAPI 的路径和 SSE 事件名与消费者镜像静态一致。它不是端到端联调通过，也不是灰度或真机通过。B2–B5 仍是本地 stand-in。
- `voiceWssUrl`：默认 `wss://lab.invalid/voice`。设置 `OPENBOT_LAB_VOICE_WSS_URL` 为本机 `ws://127.0.0.1:<port>` 后，改用实验语音。不是生产 ASR/TTS，也不是 `api.tenclass.net`
- `devicePlatformUrl`：本进程的 origin，例如 `http://127.0.0.1:8790`
- `devicePlatformEndpoints`：上面列出的 healthz、config 和 credentials。没有 grants / conversations / runs
- `openBotConnectorUrl`：另一个进程上的 OpenBot 连接器。只有 `OPENBOT_DEVICE_DH_STUB_URL` 是 loopback 时才有值，形如 `http://127.0.0.1:8787/api/integrations/v1`。没设置时是 null。它不是本 OTA 进程的地址
- `claimStatus`：`missing`、`pending` 或 `claimed`
- `pairing.next`：`issue-claim`、`redeem-claim`、`bind`、`present-claim-code` 或 `revoked`。这里不包含认领码
- `firmwareUrl`：null，`executable` 为 false，`force` 为 0

`gatewayAgentId` 和 `agentSessionForce` 只在凭证响应里。前者来自 `OPENBOT_DEVICE_DH_GATEWAY_AGENT_ID`，没设置时是 null。后者只有 `OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE=1` 时为 true。默认会话键是 `device-dh:<digitalHumanId>:<conversationId>`，不是本地 B2 的 `sessionId`。

吊销会清掉 token，公开配置的 `pairing.next` 变成 `revoked`。rebind 会把 `bindingVersion` 加 1；下一次必须重新出示认领码才能拿到新 token。旧 token 不能再读。

认领和绑定仍然走控制面（控制台或调用 `ControlPlane`），状态写在同一个 staging 文件里。这个 HTTP 服务不会调用 `flash()` 或 `massFlash()`。
