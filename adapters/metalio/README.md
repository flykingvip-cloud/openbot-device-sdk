# Metalio 语音适配

固件基线：<https://github.com/CloudZao/MetalioClaw4> `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950`

这里实现的是该提交上的 WebSocket 语音线，不是小智云生产入口。

- 客户端 hello：`transport=websocket`，`features.mcp=true`，Opus 16000 Hz、单声道、60 ms。
- 二进制：version 1 裸负载；version 2 为 16 字节大端头；version 3 为 4 字节头。
- Opus 只有占位边界。本包不链接 libopus，占位负载以 `OB-OPUS-PLACEHOLDER` 开头。
- 打断后解码队列不清空。队列上限 `2400/60=40` 包，残留最多 2400 ms。`ResetDecoder` 只在进入 Speaking 时发生。
