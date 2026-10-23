# 实验语音 WebSocket

本机回环上的语音桩。它不是生产 ASR/TTS，不使用厂商密钥，也不连接 `api.tenclass.net`。

```bash
npm run voice -- --listen 127.0.0.1:8791 --state var/lab-voice.sqlite
npm run voice -- --help
```

默认只监听 `127.0.0.1:8791`。状态文件和实验配置可以共用同一个 sqlite 或 JSON。未绑定、已吊销、绑定版本不匹配或 token 已过期的设备会被拒绝。升级时和会话进行中都用同一套凭证检查（过期、吊销、设备、`bindingVersion`）。时钟越过 `expiresAtMs` 之后，后续帧会以 `credential_expired` 关掉连接。

## 协议

客户端 hello 与 `adapters/metalio` 一致：`type=hello`、`transport=websocket`、`features.mcp=true`、Opus 16000 Hz / 单声道 / 60 ms。请求头带 `Protocol-Version`、`Device-Id`、`Client-Id`，以及已绑定设备的 `Authorization`。

服务端 hello 的 `transport` 是 `websocket`，`session_id` 就是本地 B2 会话。协议版本原样回显。

`listen` 的 `stop` 或 `detect` 调用 `finishUtterance`。识别文本默认是 `lab-transcript`，也可以在 `stop` 里带 `text`，或在二进制帧里发送以 `ASR:` 开头的说明。用户文本会写入本地 B2 stand-in 的 `user.turn`，并先发 `stt`。token 过期后不会再走 `finishUtterance`。

只有 `OPENBOT_DEVICE_DH_TEST_MODE=1` 且没有配齐 live stub 时，助手回复才是本地模拟：`stt` 和 `tts` 都标 `dialogue: sim`，`source: sim`。这不是 OpenBot 对话。`finishUtterance` 会把这段 ASR 文本拿去播占位 TTS。没设这个变量、也没配 stub 时，返回 `dialogue_unavailable`，不播 ASR 文本。

设置了 stub URL、service Basic 和 `X-OpenBot-Grant-Credential` 之后，`finishUtterance` 把用户文本提交给 OpenBot stub（grant、conversation、带 `Idempotency-Key` 的 turn、run SSE）。助手 TTS 只使用 `assistant.visible` 和 `assistant.final` 里的文本，并标 `dialogue: openbot`。不会把 ASR 文本假装成 OpenBot 的助手话。打断会 `POST /runs/{runId}/cancel`，`reason` 为 `barge_in`。凭证不全或 stub 未配置时，live 测试跳过，那不是端到端通过。B2–B5 的本地 stand-in 仍在。样例客户端口令见 openbot-vp `staging.md`，不写入本仓库。

默认下行 TTS 仍是 `OB-OPUS-PLACEHOLDER` 二进制（`MockTtsProvider`），不是可播 Opus。

注入 `createOpusFrameTtsProvider()`（或任意产出裸 Opus 的 `TtsProvider`）后，下行变为 **24 kHz / mono / 60 ms** 播报帧 Opus（`@evan/opus` / libopus WASM 或 native）。录音卡落盘 Opus 属另一 adapter，勿与 hello 常量混用。

## 打断（A4）

收到 `type=abort` 后停止继续发送，并回报 `lab.abort`（含 `queueCleared`、`abortDecodePolicy`、`residualMs`）。

- **默认 mock / placeholder**（`MockTtsProvider` → `metalio-faithful`）：已入队帧留在播放模型里，残留 ≤ 40 × 60 ms = **2400 ms**；不调用 `ResetDecoder`。2400 ms 只文档化占位路径，**不是**真 Provider 最终门闩。
- **真 TTS Provider**（如 `createOpusFrameTtsProvider()` → `clear-on-abort`）：AbortSpeaking **清解码队列**（lab = `ResetDecoder`），断言 `queueCleared === true` 且 `residualMs === 0`。

## 和实验配置的关系

`npm run ota-config` 默认把 `voiceWssUrl` 设为 `wss://lab.invalid/voice`。语音进程打印自己的 `ws://127.0.0.1:<port>` 之后，用它设置：

```bash
OPENBOT_LAB_VOICE_WSS_URL=ws://127.0.0.1:8791 npm run ota-config
```

已绑定设备的配置会改用这个地址。`api.tenclass.net` 以及其他非本机地址会被忽略，配置仍回到占位 URL。

## Provider 注入（A1）

`startLabVoiceServer` 接受可选的 `asrProvider` / `ttsProvider`。未传入时使用 `MockAsrProvider` / `MockTtsProvider`，行为与历史占位一致：

- ASR（整段 A3）：`listen` 期间的二进制 WAV/PCM 优先 → `resolveAsrAudio` + `AsrProvider.transcribe`（WAV 采样率来自文件头）。否则 `listen` 的 `text`、或以 `ASR:` 开头的二进制说明 → 同一套 mock transcript（默认 `lab-transcript`）。
- ASR（流式 A3）：`AsrProvider.stream` 为可用 stub（partial/final）；lab 默认仍走整段 `finishUtterance`。注入 FunASR 等时权重在包外。
- TTS（默认 mock）：下行仍是 `OB-OPUS-PLACEHOLDER` 帧（默认 8 包），不是可播 Opus。
- TTS（真 Opus）：传入 `ttsProvider: createOpusFrameTtsProvider()`（或自研 Provider）后，二进制帧为可解码裸 Opus，不再含 `OB-OPUS-PLACEHOLDER`。

注入自定义实现时：

```ts
import { startLabVoiceServer } from "../services/src/lab-voice.ts";
import type { AsrProvider, TtsProvider } from "../adapters/voice/src/index.ts";

const asr: AsrProvider = {
  async transcribe(audio, { sampleRate, channels }) {
    // e.g. local FunASR SenseVoiceSmall — weights stay outside this package
    return "...";
  },
  // stream(chunks) → partial/final (A3 usable stub or real FunASR inject)
};

const tts: TtsProvider = {
  async *synthesize(text, { sampleRate }) {
    // e.g. EdgeTTS over LAN → real Opus packets at hello sampleRate (default 24 kHz)
    yield opusPacket;
  },
};

await startLabVoiceServer(plane, { asrProvider: asr, ttsProvider: tts });
```

**合法外部实现**：本地 FunASR、局域网 EdgeTTS 等。本包不捆绑权重、不硬编码厂商、不连接 `api.tenclass.net`。

**TTS 下行采样率**：以 metalio server hello 为唯一真相（默认 **24 kHz** / mono / 60 ms）。不要另立 16k/24k 双标准。

**Upload 归属**：`POST /api/v1/upload` 与 `POST /api/v1/record/upload` 由 **OpenBot gateway** 适配层提供，不属于本 SDK / device-control 冻结面。本包只提供对接示例与 Provider 抽象。

