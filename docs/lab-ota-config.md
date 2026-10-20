# 实验 OTA 配置 HTTP

这是给设备和模拟器读取的本机配置服务。它不是固件烧录，也不改生产 OTA 主机。

```bash
npm run ota-config -- --listen 127.0.0.1:8790 --state var/ota-config.sqlite
npm run ota-config -- --help
```

`--state` 以 `.json` 结尾时用 JSON，否则用 sqlite。默认文件 `var/ota-config.sqlite` 已在 `.gitignore` 里，里面会有短时 token，不要提交。

## 接口

- `GET /healthz`：本进程健康检查。`firmwareUrl` 为 null。
- `GET /devices/{deviceId}/config`：该设备的实验配置。

配置里包括：

- `contractSha`：`bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a`
- `routesAligned`：true（已入库 OpenAPI 的路径和 SSE 事件名一致）
- `voiceWssUrl`：默认 `wss://lab.invalid/voice`。设置 `OPENBOT_LAB_VOICE_WSS_URL` 为本机 `ws://127.0.0.1:<port>` 后，改用实验语音。不是生产 ASR/TTS，也不是 `api.tenclass.net`
- `deviceApiUrl`：本监听地址加上 `/api/integrations/v1`。本进程不实现 grants / conversations / runs
- `claimStatus`：`missing`、`pending` 或 `claimed`
- `bindingVersion`、`authorizationRef`、`digitalHumanId`：未绑定时为 null
- `gatewayAgentId`：数字人配置需要它。来自 `OPENBOT_DEVICE_DH_GATEWAY_AGENT_ID`，没设置时是 null，不是生产网关编号
- `agentSessionForce`：只有 `OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE=1` 时为 true。默认会话键是 `device-dh:<digitalHumanId>:<conversationId>`，不是本地 B2 的 `sessionId`。别的取值不会改用 UI 会话键
- `token`：只在已认领且已绑定、并且未吊销时签发。未认领、只认领未绑定、以及吊销之后都是 null
- `firmwareUrl`：null，`executable` 为 false，`force` 为 0

吊销会清掉 token。rebind 会把 `bindingVersion` 加 1，下一次读取配置会按新绑定签发新 token。

认领和绑定仍然走控制面（控制台或调用 `ControlPlane`），状态写在同一个 staging 文件里。这个 HTTP 服务不会调用 `flash()` 或 `massFlash()`。
