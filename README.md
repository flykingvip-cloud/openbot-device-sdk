# openbot-device-sdk

Agent A 的设备平台草稿。日常开发只在 [flykingvip-cloud/openbot-device-sdk](https://github.com/flykingvip-cloud/openbot-device-sdk)。不要使用已暂停的 `upbeyond/openbot-device-sdk`。

这棵树按已落地的 A0–A4 交付重建，并加上 A5 的实验控制台、模拟器和重连：A0–A2 的固件基线和 Metalio 语音线，A3 的设备工具与媒体描述，A4 的认领 / 绑定 / OTA 控制面。旧仓库当前读不到，能对上公开固件和收回的 A0 笔记的部分按原行为实现。openbot-vp `main` 上的 squash merge 据报带有 B0–B5 stub，但本环境得到 404，仍用本地 stand-in，不把 mock 路径当成已发布路由。

## 合约针

| 项 | 值 |
|---|---|
| `OPENBOT_CONTRACT_SHA` | `41b7561222775e4ad00b056e2a535c7f950bcbe9` |
| 状态 | openbot-vp `main`，PR #9 的 squash merge |
| PR | <https://github.com/flykingvip-cloud/openbot-vp/pull/9> |
| `previousSha` | `536a963b119f0a00675516401c52dd0f6187b196`，PR #8 squash，**已作废** |
| 更早作废 | `8abdc7f9a0ae49c340de712fbba235b1064f6c7d`、`554910d835f3baadb1d753532ad510b1b477be09`、`dd6c85cae086d90c519ff1be7ad08e20d4644bba` |
| 作废 | `68e062e` @ `upbeyond/openbot` |

该提交的 OpenAPI 已放在 `contracts/openbot/device-digital-human.openapi.yaml`。消费者路径和 SSE 事件名与文件一致，`routesAligned` 为 true。B1 live stub 请求 `{OPENBOT_DEVICE_DH_STUB_URL}/api/integrations/v1/digital-humans/{id}`；未设置该环境变量时测试跳过。B0 与 B2–B5 仍用本地 stand-in。`536a963b…` 不能再当作 `officialMergeSha`。

冻结字段名不变：`authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`，以及整个 `assistant.*`。

## 固件基线

[CloudZao/MetalioClaw4](https://github.com/CloudZao/MetalioClaw4) `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950`（`main` / 标签 `latest`，2026-08-18）。板级 `main/boards/metalio-claw-4/`，目标 `esp32p4`。不要改用 `v2.0.5` 或 `v2.0.5.1`。

## 目录

| 路径 | 内容 |
|---|---|
| `contracts/` | SHA 针、冻结字段、消费者路径镜像、未拉取的 OpenAPI 槽、B0–B5 本地 stand-in |
| `sdk/` | 对外入口、媒体能力、设备工具 |
| `adapters/metalio/` | 语音线、Opus 占位边界、打断残留 2400 ms |
| `integrations/openbot-b1` | 数字人资料消费者 |
| `integrations/openbot-b2` | 会话消费者 |
| `integrations/openbot-b3` | 设备工具消费者 |
| `services/` | 认领、绑定、实验 OTA 记录、实验配置 HTTP；可选的文件 / sqlite 状态 |
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
2. 绑定写入冻结字段。再次绑定会更换 `authorizationRef`、递增 `bindingVersion`。`assistant` 字段名不变，新资料替换旧值。
3. OTA 只能给单台已绑定设备记一条不可执行的版本记录。`firmwareUrl` 为空，`force` 为 0。实验配置 HTTP 同样不提供固件 URL。

`flash()` 和 `massFlash()` 一定会失败。这里不会生产烧录，也不会批量刷机，也不会把 `https://api.tenclass.net/xiaozhi/ota/` 当作本平台入口。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run console
npm run sim
npm run ota-config -- --help
npm run voice -- --help
```

控制台和模拟器的步骤、状态文件和正式合约针见 [docs/a5-console-sim.md](docs/a5-console-sim.md)。实验配置 HTTP 见 [docs/lab-ota-config.md](docs/lab-ota-config.md)。实验语音见 [docs/lab-voice.md](docs/lab-voice.md)。

Node.js 22.18 或更新版本。`npm test` 在没有 `OPENBOT_DEVICE_DH_STUB_URL` 时跳过 live stub。

## 文档

- [docs/a0-firmware-baseline.md](docs/a0-firmware-baseline.md)
- [docs/a2-metalio-voice.md](docs/a2-metalio-voice.md)
- [docs/a4-claim-bind-ota.md](docs/a4-claim-bind-ota.md)
- [docs/lab-ota-config.md](docs/lab-ota-config.md)
- [docs/lab-voice.md](docs/lab-voice.md)
- [docs/lab-camera.md](docs/lab-camera.md)
- [docs/a5-console-sim.md](docs/a5-console-sim.md)
- [docs/integration/b1.md](docs/integration/b1.md)
- [docs/integration/b2.md](docs/integration/b2.md)
- [docs/integration/b3.md](docs/integration/b3.md)
- [docs/eng-device/checklist.md](docs/eng-device/checklist.md)
