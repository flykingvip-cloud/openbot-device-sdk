# 异地可达入口（Cloudflare quick tunnel · 临时）

生成时间：2026-10-28 11:38:49 +0800（Asia/Shanghai）  
方式：`cloudflared tunnel --url` → `*.trycloudflare.com`（**进程一停 URL 即失效**；未登录命名隧道）

| 用途 | URL |
|------|-----|
| **OTA 入口（写入设备 NVS `ota_url`）** | `https://communist-installation-driven-accessories.trycloudflare.com/xiaozhi/ota/` |
| **语音 WSS（桥 advertise，设备勿手填）** | `wss://already-custody-lamb-privacy.trycloudflare.com/` |
| OTA healthz | `https://communist-installation-driven-accessories.trycloudflare.com/healthz` |

本机仍听：桥 `0.0.0.0:8002` → 隧道；lab-voice `*:8792` → 隧道；ota-config 仅 `127.0.0.1:8790`（**不**暴露）。

验通（2026-10-28）：
- OTA POST 公网 → `websocket.url` = 上表 WSS，**无** firmware 字段
- 公网 WSS（websockets + Bearer `ctok_…`）→ **OPEN ok**；本机 `ws://127.0.0.1:8792` 同 token OPEN ok
- curl 裸 HTTP Upgrade 对 voice 隧道易超时，以 websockets/设备为准

约束：禁 cam_b / 不 PROMOTE / 不翻 gray；token ~15min，按 MAC 签发。

发给测试员时：连同 `TESTER-REMOTE.md`（模式 A）+ 刷机包；先向测试员要 MAC 再注入 `OPENBOT_DEVICE_TOKEN`。
