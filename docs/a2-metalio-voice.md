# A2 Metalio 语音线

基线：`CloudZao/MetalioClaw4` `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950`。更旧的 `v2.0.5` / `v2.0.5.1` 不能代替它。细节见 [a0-firmware-baseline.md](a0-firmware-baseline.md)。

## 握手

`adapters/metalio` 按 `WebsocketProtocol::GetHelloMessage` 组客户端 hello：

- `type=hello`
- `version` 默认 1
- `features.mcp=true`
- `transport=websocket`
- `audio_params`: opus、16000 Hz、1 通道、`frame_duration=60`

服务端 hello 的 `transport` 必须是 `websocket`。缺省采样率 24000，缺省帧长 60 ms。等 hello 的固件超时是 10 秒。通道空闲超时 120 秒。

请求头：`Protocol-Version`、`Device-Id`、`Client-Id`。token 非空且不含空格时加 `Bearer `。

## 二进制

| version | 负载 |
|---|---|
| 1（以及 2/3 以外） | 裸字节 |
| 2 | 16 字节大端头：version、type、reserved、timestamp、payload_size |
| 3 | 4 字节头：type、reserved、payload_size（uint16 大端） |

## Opus 占位边界

本仓库不链接 libopus。`placeholderEncode` 只接受一整帧 PCM（16 kHz 为 1920 字节，24 kHz 为 2880 字节），并打上 `OB-OPUS-PLACEHOLDER`。这段字节不是 Opus 包，不能送去播放。

## 打断残留 2400 ms

`AbortSpeaking` 只把 `aborted_` 置真并发送：

```json
{"session_id":"<id>","type":"abort","reason":"wake_word_detected"}
```

它不调用 `ResetDecoder`，状态仍停留在 Speaking。解码队列上限是 `2400 / 60 = 40` 包，所以打断之后最多还能留下 2400 ms。队列满时固件会堵住生产者；这个模型用 `blocked` 表示，不丢已入队的包。

`tts.start` 会清掉 `aborted_`。只有从 Idle 或 Listening 进入 Speaking 时才清空队列。已经在 Speaking 时再次 `tts.start` 不会清队列。

## Provider 注入（A1）

`adapters/voice` 定义可注入的 `AsrProvider` / `TtsProvider`，并由 `adapters/metalio` 再导出。Lab（`npm run voice`）默认 mock；真机或对接方可注入 FunASR / EdgeTTS 等外部实现，**不**把厂商或权重写进本包。

| 接口 | 形状 | 说明 |
|---|---|---|
| `AsrProvider.transcribe` | `(pcm\|wav Buffer, { sampleRate, channels }) → Promise<string>` | 整段转写 |
| `AsrProvider.stream` | 预留：chunk → partial/final | A3 接线；mock 可抛 stub |
| `TtsProvider.synthesize` | `(text, { sampleRate }) → AsyncIterable<Buffer>` | 真 Provider 下为 Opus 包 |

TTS 下行采样率跟随 **server hello**（默认 24000 Hz）。`POST /api/v1/upload` 属 OpenBot gateway，不进本包、不进冻结 `/api/device-platform/v1`。

## 不做的事

不连接 `api.tenclass.net`，不把小智 OTA 当成设备平台的语音入口。
