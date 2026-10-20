# 设备工程清单

日常仓库只使用 <https://github.com/flykingvip-cloud/openbot-device-sdk>。不要克隆 `upbeyond/openbot-device-sdk`。

## 合约

- [ ] `contracts/OPENBOT_CONTRACT_SHA` 为 `dd6c85cae086d90c519ff1be7ad08e20d4644bba`
- [ ] 仓库是 `flykingvip-cloud/openbot-vp`，不是 `upbeyond/openbot`
- [ ] 没有把作废短针 `68e062e` 写回依赖
- [ ] 文档仍写明：该提交是无父提交的恢复快照，没有 B0–B5
- [ ] B0–B5 仍走 `contracts/stand-in/b0-b5.json`，没有把 stand-in 路径当成已发布 API
- [ ] 冻结字段仍是 `authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`、`assistant.*`
- [ ] 未设置 `OPENBOT_DEVICE_DH_STUB_URL` 时不访问 live stub

## A2 语音

- [ ] 固件 SHA 仍是 `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950`
- [ ] 客户端 hello 仍是 websocket + Opus 16 kHz / 单声道 / 60 ms，`features.mcp=true`
- [ ] 协议 version 2 / 3 的二进制头长度仍是 16 和 4
- [ ] 没有引入 libopus；占位包仍带 `OB-OPUS-PLACEHOLDER`
- [ ] 打断路径不调用 ResetDecoder
- [ ] 满队列残留仍是 40 × 60 ms = 2400 ms
- [ ] 没有把 `api.tenclass.net` 配成语音或 OTA 生产入口

## A3 媒体与工具

- [ ] 屏的运行时格式仍按 RGB888、24 bpp、3 块 720×720 缓冲记录；1,036,800 只作为 RGB565 算术
- [ ] 数字人表情仍收敛到 6 类；聊天表情仍用原始名字加 `.eaf`
- [ ] 摄像头描述仍是 OV2710 / 预览裁剪 720×600 / JPEG 360×300 质量 55，且没有在 SDK 里抓帧
- [ ] `system.reboot` 不能从 B3 发出

## A4 控制面

- [ ] 认领码是 6 位，绑定前必须先认领
- [ ] rebind 更换 `authorizationRef`、递增 `bindingVersion`，不改 `assistant.*`
- [ ] `flash()` 与 `massFlash()` 仍然抛错
- [ ] 实验 OTA 记录的 `firmwareUrl` 仍是 null，`force` 仍是 0
- [ ] 拒绝量产、批量、fleet，以及十班和 C5 托管包主机
- [ ] `npm test` 与 `npm run typecheck` 为绿
