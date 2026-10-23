# Metalio 语音适配

固件基线：<https://github.com/CloudZao/MetalioClaw4> `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950`

这里实现的是该提交上的 WebSocket 语音线，不是小智云生产入口。

- 客户端 hello：`transport=websocket`，`features.mcp=true`，Opus 16000 Hz、单声道、60 ms。
- 二进制：version 1 裸负载；version 2 为 16 字节大端头；version 3 为 4 字节头。
- Opus：**播报帧**走 `OpusFrameEncoder`（`@evan/opus` = libopus native/WASM）；Lab mock 仍用 `OB-OPUS-PLACEHOLDER` 占位边界。录音存储 Opus 不进本 adapter。
- 打断策略（A4）：占位路径 `metalio-faithful` 不清队列，残留最多 2400 ms；真 `TtsProvider` 路径 `clear-on-abort` 清解码队列（lab = ResetDecoder），`queueCleared`。2400 ms **不是**真 TTS 最终门闩。

## 可注入 ASR / TTS

语音识别与合成通过 `adapters/voice` 的 `AsrProvider` / `TtsProvider` 注入，不硬编码厂商。

- 合法外部实现：本地 FunASR、局域网 EdgeTTS 等；本包不捆绑权重。
- Lab 默认 mock：占位 transcript + `OB-OPUS-PLACEHOLDER`（非可播 Opus）。注入 `createOpusFrameTtsProvider` 可得真 Opus 下行。
- ASR 双模式（A3）：整段 WAV/PCM（头内采样率）+ 流式 stub（partial/final）。
- TTS 下行采样率以 server hello 为准（默认 24 kHz）。
- `POST /api/v1/upload` 属 OpenBot gateway，不在本包。

详见 [docs/a2-metalio-voice.md](../../docs/a2-metalio-voice.md) 与 [docs/lab-voice.md](../../docs/lab-voice.md)。
