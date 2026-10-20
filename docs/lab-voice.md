# 实验语音 WebSocket

本机回环上的语音桩。它不是生产 ASR/TTS，不使用厂商密钥，也不连接 `api.tenclass.net`。

```bash
npm run voice -- --listen 127.0.0.1:8791 --state var/lab-voice.sqlite
npm run voice -- --help
```

默认只监听 `127.0.0.1:8791`。状态文件和实验配置可以共用同一个 sqlite 或 JSON。未绑定或已吊销的设备会被拒绝。

## 协议

客户端 hello 与 `adapters/metalio` 一致：`type=hello`、`transport=websocket`、`features.mcp=true`、Opus 16000 Hz / 单声道 / 60 ms。请求头带 `Protocol-Version`、`Device-Id`、`Client-Id`，以及已绑定设备的 `Authorization`。

服务端 hello 的 `transport` 是 `websocket`，`session_id` 就是本地 B2 会话。协议版本原样回显。

`listen` 的 `stop` 或 `detect` 走模拟 ASR。没有真实音频解码。识别文本默认是 `lab-transcript`，也可以在 `stop` 里带 `text`，或在二进制帧里发送以 `ASR:` 开头的说明。识别结果会写入 B2 会话事件 `user.turn`，并先发 `stt`。

下行 TTS 是 `OB-OPUS-PLACEHOLDER` 二进制，不是 Opus 包，也不链接 libopus。

## 打断

收到 `type=abort` 后停止继续发送。已经交给播放模型的帧留在队列里，上限仍是 40 × 60 ms = 2400 ms。打断不调用 `ResetDecoder`，也不会把队列清空。

## 和实验配置的关系

`npm run ota-config` 默认把 `voiceWssUrl` 设为 `wss://lab.invalid/voice`。语音进程打印自己的 `ws://127.0.0.1:<port>` 之后，用它设置：

```bash
OPENBOT_LAB_VOICE_WSS_URL=ws://127.0.0.1:8791 npm run ota-config
```

已绑定设备的配置会改用这个地址。`api.tenclass.net` 以及其他非本机地址会被忽略，配置仍回到占位 URL。
