# Voice providers（可注入 ASR / TTS）

公共抽象层，供 `adapters/metalio` 与后续录音卡 adapter 复用。

- **AsrProvider** — `transcribe(pcm|wav, { sampleRate, channels }) → Promise<string>`；流式 `stream` 为预留形状。
- **TtsProvider** — `synthesize(text, { sampleRate }) → AsyncIterable<Buffer>`（真 Provider 下为 Opus 包）。

运行时注入。Lab 默认 `MockAsrProvider` / `MockTtsProvider` 保持占位 transcript 与 `OB-OPUS-PLACEHOLDER` 行为。

合法外部实现示例：本地 FunASR SenseVoiceSmall、局域网 EdgeTTS。本包不捆绑权重，不硬编码厂商，不连接 `api.tenclass.net`。

TTS 下行采样率以 metalio **server hello** 为准（默认 24 kHz / mono / 60 ms）。`POST /api/v1/upload` 与 `/api/v1/record/upload` 由 OpenBot gateway 提供，不属于本包。
