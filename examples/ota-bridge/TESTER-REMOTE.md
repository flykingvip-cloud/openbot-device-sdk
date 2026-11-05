# 异地工程测试说明 — MetalioClaw4 开机自连 OpenBot 语音

**固件 tip**：`3d12a6ea`（AbortSpeaking→ResetDecoder）  
**SDK tip**：`87a4a1a` / npm `@0.1.0`  
**禁区**：不 PROMOTE、不动 cam_b、不翻 grayRelease；**不要**把平台 service Basic 烧进固件。

异地测试员与实验室**不在同一局域网**时，不能直接用 `192.168.1.138`。下面两种模式二选一。

---

> **当前实验室公网入口（临时 Cloudflare quick tunnel）**：见同目录 [`PUBLIC-ENDPOINTS.md`](./PUBLIC-ENDPOINTS.md)。隧道进程重启后 URL 会变，以该文件为准。


## 模式 A（推荐）：实验室提供公网/隧道入口，测试员只刷机 + 配网

### 实验室须交给测试员的材料

| # | 材料 | 说明 |
|---|---|---|
| 1 | 刷机包 | `MetalioClaw4-3d12a6ea-full-flash-20261025.zip` + zip sha256 `99d92d3ed966e6364517f4b41382bbda3a2c539846bba9796c325b6439829743` |
| 2 | 刷机参数 | 芯片 esp32p4；Flash 32MB / dio / 40m；见包内 `README_FLASH.txt` |
| 3 | **OTA 入口 URL** | 公网或隧道可达，形如 `https://ota.example.com/xiaozhi/ota/` 或临时 `http://…:8002/xiaozhi/ota/`（须含路径与末尾 `/`） |
| 4 | **语音 WSS URL** | 仅供核对/排障；设备实际从 OTA 响应里拿，无需手填。须与桥下发一致，且设备网络可达 |
| 5 | 设备登记 | 测试员报 **MAC（Device-Id）** → 实验室 claim→bind→签发 15min token 并注入桥；过期需重签或 refresh |
| 6 | 验收标准 | 见下文「通过标准」 |
| 7 | 联系人/回报渠道 | 串口日志、OTA curl 结果、失败现象 |

实验室**不要**把这些交给测试员：service Basic 口令、gateway grant `azr_*`、ota-config 的 loopback 地址、内部 sqlite。

### 测试员步骤

1. 按 `README_FLASH.txt` 全量刷机（`esptool … @flash_args`）。
2. 配网：写入 Wi‑Fi；将 NVS **`wifi/ota_url`** 设为实验室给的 **OTA 入口 URL**（切勿保留默认 `https://api.tenclass.net/xiaozhi/ota/`）。
3. 把设备 **MAC** 发给实验室，等对方确认「已签发并注入桥」。
4. 重启设备，观察串口：应请求该 OTA URL，收到 `websocket.url` / `token`，再连 WSS hello。
5. 冒烟：能进 Listening/Speaking；打断（AbortSpeaking）后应停播且不续播迟到包（tip `3d12a6ea`）。
6. **不要**在固件里配置 OpenBot Basic / grant。

### 测试员自测（可选，有电脑且能访问 OTA 入口时）

```bash
curl -sS -X POST '<OTA入口URL>' \
  -H 'Content-Type: application/json' \
  -H 'Device-Id: <本机MAC>' \
  -H 'Client-Id: smoke' \
  -d '{}'
```

期望：JSON 含 `websocket.url`、`websocket.token`、`server_time`；**不得**含 `firmware`。

---

## 模式 B：测试员自建本机三件套（实验室只给包与文档）

适用于测试员有自己的 Mac/Linux，设备与其电脑同网。

### 实验室另交

| # | 材料 |
|---|---|
| 1 | 同上刷机包 + sha256 |
| 2 | `openbot-device-sdk` tip `87a4a1a`（或至少 `examples/ota-bridge/` + 能 `npm run voice` / `ota-config` 的 checkout） |
| 3 | 本说明 + `examples/ota-bridge/README.md`、`OPS-CHECKLIST.md` |

### 测试员本机起栈（摘要）

```bash
# 终端 1 — lab-voice（对设备绑 0.0.0.0；打印多为 ws://127.0.0.1:端口）
cd openbot-device-sdk
OPENBOT_DEVICE_DH_TEST_MODE=1 \
  npm run voice -- --listen 0.0.0.0:8792 --state var/lab-boot-voice.sqlite

# 终端 2 — ota-config（仅 loopback；voiceWssUrl 只能是 127.0.0.1/localhost）
OPENBOT_LAB_VOICE_WSS_URL='ws://127.0.0.1:8792' \
  npm run ota-config -- --listen 127.0.0.1:8790 --state var/lab-boot-voice.sqlite

# 认领/绑定/签发 token（deviceId = 真机 MAC），再：

# 终端 3 — OTA 桥（对设备 advertise 用测试员电脑的局域网 IP）
cd examples/ota-bridge
BRIDGE_PORT=8002 \
OPENBOT_OTA_CONFIG_URL=http://127.0.0.1:8790 \
OPENBOT_DEVICE_ID='<MAC>' \
OPENBOT_DEVICE_TOKEN='<token>' \
OPENBOT_VOICE_WSS_ADVERTISE_URL='ws://<测试员电脑局域网IP>:8792/' \
  node server.mjs
```

设备 NVS `ota_url` = `http://<测试员电脑局域网IP>:8002/xiaozhi/ota/`。

注意：ota-config **拒绝**把 `voiceWssUrl` 设成非 loopback；设备可达地址必须靠桥的 `OPENBOT_VOICE_WSS_ADVERTISE_URL`。

---

## 通过标准（两种模式共用）

- [ ] 刷机后版本/行为对应 tip `3d12a6ea`
- [ ] `ota_url` 指向约定 OTA 入口，非 tenclass 默认
- [ ] OTA 响应无 `firmware` 字段
- [ ] 设备连上 WSS 并完成 hello（串口无长期证书/401/credential_expired）
- [ ] 能触发一轮听/说（lab 可为 mock TTS；听感非本阶段必过）
- [ ] AbortSpeaking 后停播、不拖尾续播
- [ ] 未使用 cam_b / 未要求 PROMOTE / 未翻 gray

## 常见失败

| 现象 | 处理 |
|---|---|
| 仍访问 tenclass | NVS `ota_url` 未改或为空 |
| OTA 通但 WSS 失败 | advertise URL 对测试员网络不可达；或 token 过期（15min） |
| `credential_expired` | 实验室/本机 refresh 或重签 token |
| 响应含 firmware 并开始刷机 | **立即停**；桥配置错误，联系实验室 |
| 只有 upload 通、WSS 不通 | 18789 upload 与原生 WSS 是两条路；本验收看 OTA→WSS |

## 实验室侧（模式 A）上公网前自检

1. 桥与 voice 均对公网或隧道暴露；**不要**把 ota-config `:8790` 暴露到公网。
2. 桥下发的 `websocket.url` 必须是设备能解析的 `ws://`/`wss://`（公网优先 `wss` + 可靠 `server_time`）。
3. curl 从**测试员同类型网络**打 OTA 入口，确认非仅实验室内网通。
4. token 按 MAC 签发；告知有效期与续期方式。
