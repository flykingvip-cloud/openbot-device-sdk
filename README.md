# openbot-device-sdk

Agent A 的设备平台草稿。日常开发只在 [flykingvip-cloud/openbot-device-sdk](https://github.com/flykingvip-cloud/openbot-device-sdk)。不要使用已暂停的 `upbeyond/openbot-device-sdk`。

这棵树按已落地的 A0–A4 交付重建，并加上 A5 的实验控制台、模拟器和重连：A0–A2 的固件基线和 Metalio 语音线，A3 的设备工具与媒体描述，A4 的认领 / 绑定 / OTA 控制面。旧仓库当前读不到，能对上公开固件和收回的 A0 笔记的部分按原行为实现。openbot-vp PR #7 的合并前 tip 据报已有 B0–B5，但本环境得到 404，仍用本地 stand-in，不把 mock 路径当成已发布路由。

## 合约针

| 项 | 值 |
|---|---|
| `OPENBOT_CONTRACT_SHA` | `554910d835f3baadb1d753532ad510b1b477be09` |
| 状态 | openbot-vp PR #7 的**合并前** tip，还不是 `main` 上的正式 SHA |
| PR | <https://github.com/flykingvip-cloud/openbot-vp/pull/7> |
| 上一枚针 | `dd6c85cae086d90c519ff1be7ad08e20d4644bba`（无父提交的恢复快照） |
| 作废 | `68e062e` @ `upbeyond/openbot` |

Agent B 说明 B0–B5 在这个 tip 上。本环境请求 `flykingvip-cloud/openbot-vp` 得到 404，读不到路由，因此仍使用 `contracts/stand-in/b0-b5.json` 里的本地 mock，没有按 PR tip 改路径。Agent B 合并到 `main` 并给出正式 SHA 之后，再替换 `OPENBOT_CONTRACT_SHA`。设置 `OPENBOT_DEVICE_DH_STUB_URL` 之后，B1 才会请求 live stub；否则测试跳过该用例。

冻结字段名不变：`authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`，以及整个 `assistant.*`。

## 固件基线

[CloudZao/MetalioClaw4](https://github.com/CloudZao/MetalioClaw4) `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950`（`main` / 标签 `latest`，2026-08-18）。板级 `main/boards/metalio-claw-4/`，目标 `esp32p4`。不要改用 `v2.0.5` 或 `v2.0.5.1`。

## 目录

| 路径 | 内容 |
|---|---|
| `contracts/` | SHA 针、冻结字段、B0–B5 本地 stand-in |
| `sdk/` | 对外入口、媒体能力、设备工具 |
| `adapters/metalio/` | 语音线、Opus 占位边界、打断残留 2400 ms |
| `integrations/openbot-b1` | 数字人资料消费者 |
| `integrations/openbot-b2` | 会话消费者 |
| `integrations/openbot-b3` | 设备工具消费者 |
| `services/` | 认领、绑定、实验 OTA 记录；可选的文件 / sqlite 状态 |
| `console/` | 认领、绑定、OTA、refresh、吊销的实验控制台 |
| `simulator/` | 无真机的 B1–B3 stand-in 与重连模拟 |
| `docs/` | A0 笔记、A2、A4、A5、B1–B3、工程清单 |

## 语音与媒体

- WebSocket hello：Opus、16000 Hz、单声道、60 ms，`features.mcp=true`
- 二进制 version 1 裸负载，version 2 / 3 为固件里的大端帧头
- 不链接 libopus。占位包带 `OB-OPUS-PLACEHOLDER`，只标记 60 ms 帧边界
- 打断不清理解码队列。队列上限 40 包，残留最多 **2400 ms**
- 数字人表情收敛为 6 类；聊天表情用 `system/chat/{name}.eaf`
- 量产屏初始化是 720×720 RGB888，不是 RGB565 帧缓冲

## 认领、绑定、OTA

控制面默认在内存里工作，方便单元测试。`npm run console` 和 `npm run sim` 把同一份状态写进本地 sqlite 或 JSON，进程退出后还能读回来。认领、绑定和 OTA 的规则不变：

1. 6 位认领码，通过后才能绑定。
2. 绑定写入冻结字段。再次绑定会更换 `authorizationRef`、递增 `bindingVersion`，并原样保留 `assistant.*`。
3. OTA 只能给单台已绑定设备记一条不可执行的版本记录。`firmwareUrl` 为空，`force` 为 0。

`flash()` 和 `massFlash()` 一定会失败。这里不会生产烧录，也不会批量刷机，也不会把 `https://api.tenclass.net/xiaozhi/ota/` 当作本平台入口。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run console
npm run sim
```

控制台和模拟器的步骤、状态文件和合并前合约针见 [docs/a5-console-sim.md](docs/a5-console-sim.md)。

Node.js 22.18 或更新版本。`npm test` 在没有 `OPENBOT_DEVICE_DH_STUB_URL` 时跳过 live stub。

## 文档

- [docs/a0-firmware-baseline.md](docs/a0-firmware-baseline.md)
- [docs/a2-metalio-voice.md](docs/a2-metalio-voice.md)
- [docs/a4-claim-bind-ota.md](docs/a4-claim-bind-ota.md)
- [docs/a5-console-sim.md](docs/a5-console-sim.md)
- [docs/integration/b1.md](docs/integration/b1.md)
- [docs/integration/b2.md](docs/integration/b2.md)
- [docs/integration/b3.md](docs/integration/b3.md)
- [docs/eng-device/checklist.md](docs/eng-device/checklist.md)
