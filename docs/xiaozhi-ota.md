# Xiaozhi OTA（MetalioClaw4 联调）

对固件暴露小智协议 OTA 配置口：`POST|GET /xiaozhi/ota/`。
已绑定设备由本进程 **in-process** 调用 `ControlPlane.issueConnectionCredential` 签发短时裸 token；
语音 WebSocket 协议仍走现有 `npm run voice` / `npm run claw4-lab`，本端点只负责下发可达的 `websocket.url` + `token` + `server_time`。

远端测试者（真机不在本机）逐步清单见 [xiaozhi-ota-remote-tester.md](./xiaozhi-ota-remote-tester.md)。

## 推荐：联合启动（同一 ControlPlane）

OTA 签发的 token 必须与 lab-voice 校验共用同一份 sqlite。拆开两个默认库会导致「OTA 有 token、WS 仍 401」。

```bash
# 把 <LAN-IP> 换成设备能 ping 到的本机地址；--bind-device 为真机 MAC（Device-Id）
npm run claw4-lab -- \
  --voice-ws 'ws://<LAN-IP>:8791' \
  --bind-device '80:f1:b2:d2:eb:fb'
```

默认：OTA `0.0.0.0:8002`，voice `0.0.0.0:8791`，状态 `var/claw4-lab.sqlite`。
`--bind-device` 走 lab 认领+绑定（非生产 OpenBot grant），真机联调前置。

固件 tip `3d12a6ea` **没有**「服务器地址」UI；用仓库外工具 `claw4-set-ota-url.py`（或等价）写 NVS `wifi/ota_url`，再**断电重启**。
设备与电脑须同局域网，确认设备网络是 WiFi 不是 4G。

WS 握手必须带 `Client-Id`（UUID）；缺了 lab-voice 会 400。OTA HTTP 也会打出 Device-Id / Client-Id / UA 日志。

## 仅 OTA（须自行对齐 --state）

```bash
npm run xiaozhi-ota -- \
  --listen 0.0.0.0:8002 \
  --state var/claw4-lab.sqlite \
  --voice-ws 'ws://192.168.x.x:8791'
# 或: export OPENBOT_XIAOZHI_VOICE_WS_URL='wss://openbot.example.com/voice'
# 另起: npm run voice -- --listen 0.0.0.0:8791 --state var/claw4-lab.sqlite
```

设备 NVS `wifi/ota_url` 填：`http://<本机局域网IP>:8002/xiaozhi/ota/`

## 自测

```bash
curl -sS -X POST 'http://127.0.0.1:8002/xiaozhi/ota/' \
  -H 'Content-Type: application/json' \
  -H 'Device-Id: 80:f1:b2:d2:eb:fb' \
  -H 'Client-Id: 00000000-0000-0000-0000-000000000000' \
  -d '{"mac_address":"80:f1:b2:d2:eb:fb"}'
```

期望：`200`，JSON 含非空 `websocket.url`、`server_time.timestamp` 接近当前时间；**无** `mqtt` / `firmware`。
进程 stderr 会出现类似：

```
[09:01:02] OTA POST from deviceId=80:f1:b2:d2:eb:fb
	clientId=00000000-0000-0000-0000-000000000000
	UA=...
	-> ws=ws://192.168.x.x:8791 token=(issued)
```

## 硬约束

- 响应禁止带 `mqtt`（固件会优先走 MQTT，忽略 websocket）
- 禁止省略 `server_time`（缺了设备时钟 1970，`wss` 证书校验失败）
- 联调期禁止下发 `firmware`
- `websocket.url` 必须是设备可达地址，不要用 `listening.url` 在 `0.0.0.0` 时改写成的 `127.0.0.1`
- OTA 与 voice 必须共享 ControlPlane 状态（`npm run claw4-lab` 或相同 `--state`）
- 现有 lab `ota-config`（loopback `LabDeviceConfig`）保持不变

## 联调回填清单（运维）

1. 本机 LAN IP、OTA URL、advertise `ws://…:8791`
2. NVS `wifi/ota_url` 已写且断电重启
3. `--bind-device` 与真机 MAC 一致
4. OTA 日志里能看到 Device-Id / Client-Id；token=(issued)
5. 设备 WS 带同一 Client-Id；无 400/401

过渡期仍可用 `examples/ota-bridge/`（环境变量静态 token）；生产形态应使用本服务共享 ControlPlane 状态。
