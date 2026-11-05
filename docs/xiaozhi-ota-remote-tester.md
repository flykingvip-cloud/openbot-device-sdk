# MetalioClaw4 远端测试者联调清单

> **读者**：手上有 MetalioClaw4 真机的远端测试者  
> **目标**：把设备指到 OpenBot 后台（小智协议 OTA + 语音 WebSocket），跑通一轮开机 → OTA → 连语音  
> **你不需要**：拉 `openbot-device-sdk` 仓库、起服务、改代码  
> **后台负责人会给你**：OTA URL、语音 URL、以及本机是否已按你的 MAC 完成 lab 绑定

---

## 当前 lab 入口（2026-11-05）

- OTA：`https://device-lab.openbot.love/xiaozhi/ota/`
- 语音：`wss://device-lab.openbot.love/`
- 样例设备 MAC `80:f1:b2:d2:eb:fb` 已在 HK `claw4-lab` 完成 lab 绑定；其他 MAC 请先发给后台。

---

## 0. 先确认设备身份（发给后台）

联调前，把下面信息发回后台负责人（没有就对照屏幕 / 串口 / 上次刷机记录）：

| 项 | 本机已知样例（仅供对照） | 你的实机 |
|---|---|---|
| 产品 | Metalio Claw4 | |
| 固件 tip | `3d12a6ea…` / 应用版本 `2.0.51` | |
| **Device-Id（MAC）** | `80:f1:b2:d2:eb:fb`（小写、冒号分隔） | |
| **Client-Id（板级 UUID）** | `45081946-8ea4-4e54-99aa-303e1a092f77` | |
| 当前网络 | 必须是 **WiFi**，不能是 4G | |

> Device-Id 就是 MAC。Client-Id 是板子 UUID，**每次连语音 WebSocket 都会带上；缺了服务端会 400**。  
> 若你手上不是样例这台，务必以实机 MAC / UUID 为准，不要照抄样例。

---

## 1. 后台会发给你的地址（粘贴区）

收到后填在这里，后面步骤只引用这些值：

| 名称 | 示例形态 | 后台填好发给你 |
|---|---|---|
| **OTA URL** | `https://device-lab.openbot.love/xiaozhi/ota/` | 已部署（HK lab） |
| **语音 URL（对照用）** | `wss://device-lab.openbot.love/` | 已部署；由 OTA 下发 |
| lab 绑定 | 样例 MAC `80:f1:b2:d2:eb:fb` 已在 HK lab 绑定 | 其他 MAC 需后台再 `--bind-device` |

要求：

- OTA / 语音地址必须是**设备当前网络能访问到的公网或隧道地址**（不能是后台同事电脑的 `192.168.*`，除非你和他在同一局域网）。
- OTA 必须是小智协议口：路径以 `/xiaozhi/ota/` 结尾；**不要**用 lab 的 `/devices/{id}/config`。
- 语音 URL 一般由 OTA 响应下发，你通常**不用在设备上手填**；列在这里是为了联调失败时对照。

---

## 2. 设备侧步骤（按顺序做）

### 2.1 网络

1. 设备开机，进入网络设置。
2. 连上可访问公网的 **WiFi**（能开网页那种）。
3. 若机型带 4G：在「网络切换」里确认当前是 **`WiFi`，不是 `4G`**。  
   屏幕里「已保存 WiFi」只表示历史记录，**不代表当前已连上**。

### 2.2 写入 OTA 地址（本固件没有「服务器地址」UI）

固件 tip `3d12a6ea` **没有**设置页里的「服务器地址」项。用 NVS 工具写 `wifi/ota_url`：

1. 向后台或固件同学要 `claw4-set-ota-url.py`（或等价 NVS 写入工具）和 USB / 串口连接方式。
2. 把 **第 1 节的 OTA URL** 完整写入 NVS 键 `wifi/ota_url`（含 `http(s)://` 与末尾 `/xiaozhi/ota/`）。
3. **断电重启**（软重启有时读不到新 NVS；以拔电为准）。

不要填：

- `https://api.tenclass.net/xiaozhi/ota/`（官方小智云，不是 OpenBot）
- 后台同事的 `127.0.0.1` / `192.168.*`（除非你确认设备与那台机器同网且能 ping 通）


## 2.5 真机交互（极易误判）

- 本固件**默认关闭唤醒词**；光喊名字不会连语音。
- 开机后会先 `POST` OTA，然后停在 **idle**；要进屏幕上的 **「聊天」App**（点亮后还要点进 App）才会建 WebSocket。
- 语音连接是**短时按需**的，聊完可能断开；在线请看 OTA 日志，不要只看 WS 是否常连。
- 断电请**长按电源键关机再开**；拔 USB / 软复位经常不够。
- 后台联调时**不要**对已绑定 MAC 随意 `curl` OTA：每次 OTA 都会重新 `issueConnectionCredential`，会顶掉设备手里的 token。

### 2.3 观察设备行为

重启后约 **12 秒内**应发起 OTA。正常时你会看到设备去拉配置，随后尝试连语音；屏幕可能出现绑定 / 对话相关 UI。

若长时间无请求：

1. 再确认当前是 WiFi 且已关联成功（不是只「已保存」）。
2. 再确认不是 4G。
3. 把串口日志（若有）和大概时间点发给后台，让他看服务端是否收到 OTA。

### 2.4 你不需要做的事

- 不需要自己签 token、改固件、装 Node、跑 `npm run claw4-lab`。
- 不需要在设备上单独填语音 URL（由 OTA JSON 的 `websocket.url` + `token` 下发）。
- 联调期不要指望 OTA 下发升级包；响应里不应出现可用的 `firmware` 升级。

---

## 3. 和后台对结果（口头 / 聊天即可）

请后台在服务端日志里确认类似行（时间、MAC、Client-Id 对得上你这台）：

```
[HH:MM:SS] OTA POST from deviceId=<你的MAC>
	clientId=<你的Client-Id>
	UA=metalio-claw-4/<版本>
	-> ws=<语音URL> token=(issued)
```

含义速查：

| 日志 | 含义 | 你这边可配合 |
|---|---|---|
| 完全没有 OTA 行 | 设备没打到后台 | 查 WiFi / 4G / OTA URL / 防火墙 |
| `token=(empty)` 且 `unbound` | 设备未 lab 绑定 | 把 MAC 再发一次，等后台 `--bind-device` |
| `token=(issued)` 但设备仍连不上语音 | WS / TLS / Client-Id / 网络 | 确认 WiFi；把失败现象与时间发给后台 |
| WS 400 | 常缺 `Client-Id` | 固件应自带；若被改过固件再报 |

成功标准（最小）：

1. 后台看到对本机 MAC 的 OTA，且 `token=(issued)`  
2. 设备随后连上语音 WebSocket（后台有会话 / 你能听到或看到一轮对话回执）

---

## 4. 回填给后台的模板（复制填空）

```text
【远端联调回填】
Device-Id(MAC): 
Client-Id: 
固件版本 / tip: 
当前网络: WiFi / 4G（圈一个）; SSID: 
已写入 wifi/ota_url: 
写入工具: claw4-set-ota-url.py / 其他: 
断电重启时间(本地时区): 
设备现象: （有无连网图标 / 有无报错文案 / 是否开始说话）
串口要点: （可选，贴最后 30 行）
```

---

## 5. 后台侧（给负责人，测试者可略读）

远端场景不要 advertise 局域网 IP。推荐：

```bash
# 本机或跳板：OTA + voice 同进程、同 sqlite；voice/OTA 须对公网或隧道可达
npm run claw4-lab -- \
  --voice-ws 'wss://<公网或隧道主机>/...' \
  --bind-device '<测试者MAC>' \
  --ota-listen 0.0.0.0:8002 \
  --voice-listen 0.0.0.0:8791
```

- `--voice-ws` 填**设备能连上的** `ws`/`wss`，不要填 `0.0.0.0` 派生的 `127.0.0.1`。  
- 用 Cloudflare Tunnel / frp / 已有反代时，OTA 与 voice 路径按反代实际对外 URL 发给测试者。  
- TLS：若只开 `wss`，设备时钟依赖 OTA 里的 `server_time`；不要省略。  
- 协议细节与本地自测见 [xiaozhi-ota.md](./xiaozhi-ota.md)。


## 验喇叭与多轮（lab）

HK lab 可开：

- `OPENBOT_DEVICE_DH_TEST_MODE=1`：无 live stub 时走 **sim** 多轮（`dialogue: sim`），每轮 TTS 播识别文本
- `OPENBOT_TTS_PROVIDER=reference-http` + `OPENBOT_TTS_HTTP_URL=http://127.0.0.1:8800/tts`（本机 `ops/lab-edgetts`）

这是喇叭与会话生命周期验收，**不是** OpenBot 生产对话。真 ASR 需另配 FunASR HTTP；真助手需配 live stub。
