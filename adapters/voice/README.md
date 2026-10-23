# Voice providers（可注入 ASR / TTS）

公共抽象层，供 `adapters/metalio` 与后续录音卡 adapter 复用。

- **AsrProvider** — 双模式（A3）：
  - **整段** `transcribe(pcm|wav, { sampleRate, channels, format? }) → Promise<string>`；WAV 时用 `resolveAsrAudio` / `parseWavPcm` 从文件头取采样率与声道。
  - **流式** `stream(chunks) → AsyncIterable<partial|final>`；Lab mock 为可用 stub，真 Provider 注入后走实时线。
- **TtsProvider** — `synthesize(text, { sampleRate }) → AsyncIterable<Buffer>`（真 Provider 下为 Opus 包）。

运行时注入。Lab 默认 `MockAsrProvider` / `MockTtsProvider` 保持占位 transcript 与 `OB-OPUS-PLACEHOLDER` 行为。

合法外部实现示例：本地 **FunASR SenseVoiceSmall**、局域网 EdgeTTS。本包不捆绑权重，不硬编码厂商，不连接 `api.tenclass.net`。

TTS 下行采样率以 metalio **server hello** 为准（默认 24 kHz / mono / 60 ms）。`POST /api/v1/upload` 与 `/api/v1/record/upload` 由 OpenBot gateway 提供，不属于本包。

## 真 Opus（A2）

- `OpusFrameTtsProvider` / `createOpusFrameTtsProvider`：用可注入的 `OpusFrameEncoder`（默认 `LibopusFrameEncoder` @ `@evan/opus`）产出裸 Opus 播报帧。
- Mock 仍发 `OB-OPUS-PLACEHOLDER`。录音存储 Opus 不在本包。

## ASR 辅助（A3）

- `isWavBuffer` / `parseWavPcm` / `buildWavPcm` — RIFF/WAVE PCM 读写。
- `resolveAsrAudio` — 整段入口规范化（WAV 头覆盖 sampleRate/channels）。

设备能力矩阵（mic/storage/ble/usb/speaker 可选）与 metalio / record-card 槽位见 [docs/a5-device-capability-matrix.md](../../docs/a5-device-capability-matrix.md)。
