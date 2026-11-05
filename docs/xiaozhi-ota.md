# Xiaozhi OTA（MetalioClaw4 联调）

对固件暴露小智协议 OTA 配置口：`POST|GET /xiaozhi/ota/`。
已绑定设备由本进程 **in-process** 调用 `ControlPlane.issueConnectionCredential` 签发短时裸 token；
语音 WebSocket 协议仍走现有 `npm run voice`，本端点只负责下发可达的 `websocket.url` + `token` + `server_time`。

## 启动

```bash
# 与 lab-voice / device-control 默认 8791 错开；voice 先对局域网或反代可达
npm run xiaozhi-ota -- \
  --listen 0.0.0.0:8002 \
  --state var/xiaozhi-ota.sqlite \
  --voice-ws 'ws://192.168.x.x:8791'
# 或: export OPENBOT_XIAOZHI_VOICE_WS_URL='wss://openbot.example.com/voice'
```

设备 NVS「服务器地址」填：`http://<本机局域网IP>:8002/xiaozhi/ota/`

## 自测

```bash
curl -sS -X POST 'http://127.0.0.1:8002/xiaozhi/ota/' \
  -H 'Content-Type: application/json' \
  -H 'Device-Id: 80:f1:b2:d2:eb:fb' \
  -H 'Client-Id: 00000000-0000-0000-0000-000000000000' \
  -d '{"mac_address":"80:f1:b2:d2:eb:fb"}'
```

期望：`200`，JSON 含非空 `websocket.url`、`server_time.timestamp` 接近当前时间；**无** `mqtt` / `firmware`。

## 硬约束

- 响应禁止带 `mqtt`（固件会优先走 MQTT，忽略 websocket）
- 禁止省略 `server_time`（缺了设备时钟 1970，`wss` 证书校验失败）
- 联调期禁止下发 `firmware`
- `websocket.url` 必须是设备可达地址，不要用 `listening.url` 在 `0.0.0.0` 时改写成的 `127.0.0.1`
- 现有 lab `ota-config`（loopback `LabDeviceConfig`）保持不变

过渡期仍可用 `examples/ota-bridge/`（环境变量静态 token）；生产形态应使用本服务共享 ControlPlane 状态。
