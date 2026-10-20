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

- `contractSha`：`536a963b119f0a00675516401c52dd0f6187b196`
- `routesAligned`：false（OpenAPI 槽未拉取）
- `voiceWssUrl`：`wss://lab.invalid/voice`。这是占位，不是 ASR/TTS，也不是 `api.tenclass.net`
- `deviceApiUrl`：本监听地址加上 `/api/integrations/v1`。本进程不实现 grants / conversations / runs
- `claimStatus`：`missing`、`pending` 或 `claimed`
- `bindingVersion`、`authorizationRef`、`digitalHumanId`：未绑定时为 null
- `token`：只在已认领且已绑定、并且未吊销时签发。未认领、只认领未绑定、以及吊销之后都是 null
- `firmwareUrl`：null，`executable` 为 false，`force` 为 0

吊销会清掉 token。rebind 会把 `bindingVersion` 加 1，下一次读取配置会按新绑定签发新 token。

认领和绑定仍然走控制面（控制台或调用 `ControlPlane`），状态写在同一个 staging 文件里。这个 HTTP 服务不会调用 `flash()` 或 `massFlash()`。
