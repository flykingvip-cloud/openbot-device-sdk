# openbot-device-sdk

Agent A 的设备平台草稿。日常开发只在 [flykingvip-cloud/openbot-device-sdk](https://github.com/flykingvip-cloud/openbot-device-sdk)。不要使用已暂停的 `upbeyond/openbot-device-sdk`。

这棵树按已落地的 A0–A4 交付重建，并加上 A5 的实验控制台、模拟器和重连：A0–A2 的固件基线和 Metalio 语音线，A3 的设备工具与媒体描述，A4 的认领 / 绑定 / OTA 控制面。旧仓库当前读不到，能对上公开固件和收回的 A0 笔记的部分按原行为实现。B0–B5 的本地 stand-in 还在。设置 `OPENBOT_DEVICE_DH_STUB_URL` 后，可以用 loopback 消费者访问本机 stub，这不是灰度交付。

## 合约针

| 项 | 值 |
|---|---|
| `OPENBOT_CONTRACT_SHA` | `bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a` |
| 状态 | openbot-vp `main`，PR #10 的 squash merge |
| PR | <https://github.com/flykingvip-cloud/openbot-vp/pull/10> |
| `previousSha` | `41b7561222775e4ad00b056e2a535c7f950bcbe9`，PR #9 squash，**已作废** |
| 更早作废 | `536a963b119f0a00675516401c52dd0f6187b196`、`8abdc7f9a0ae49c340de712fbba235b1064f6c7d`、`554910d835f3baadb1d753532ad510b1b477be09`、`dd6c85cae086d90c519ff1be7ad08e20d4644bba` |
| 作废 | `68e062e` @ `upbeyond/openbot` |

该提交的 OpenAPI 已放在 `contracts/openbot/device-digital-human.openapi.yaml`。消费者路径和 SSE 事件名与文件一致，`routesAligned` 为 true。`npm run live-stub` 在 `OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787` 上探测根路径 `GET /healthz`，能力路径仍在 `/api/integrations/v1`。未设置该环境变量时不访问网络。数字人 GET 需要 service Basic 和 grant 凭证，未设置时跳过。B0 与 B2–B5 的本地 stand-in 处理器还在，没有改成 stub 的服务端。`41b75612…` 不能再当作 `officialMergeSha`。

数字人配置带 `gatewayAgentId`（来自 `OPENBOT_DEVICE_DH_GATEWAY_AGENT_ID`，未设置时为 null）。默认代理会话键是 `device-dh:<digitalHumanId>:<conversationId>`。只有 `OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE=1` 时才改用调用方给出的 UI 会话键。这不改冻结字段名，也不替换本地 B2 的 `sessionId`。

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
npm run live-stub -- --help
```

控制台和模拟器的步骤、状态文件和正式合约针见 [docs/a5-console-sim.md](docs/a5-console-sim.md)。实验配置 HTTP 见 [docs/lab-ota-config.md](docs/lab-ota-config.md)。实验语音见 [docs/lab-voice.md](docs/lab-voice.md)。

Node.js 22.18 或更新版本。`npm test` 在没有 `OPENBOT_DEVICE_DH_STUB_URL` 时跳过 live stub。数字人或摄像头的 live 用例在凭证未设置时也跳过。

```bash
OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787 npm run live-stub
```

步骤和样例客户端环境变量见 [docs/live-stub.md](docs/live-stub.md)。

## Agent A 验收还差什么

这一段仍是协议 / 模拟脚手架。A0–A5 没有灰度完成，本仓库也不烧录板子。

- 真实 Opus、ASR、TTS。现在只有 `OB-OPUS-PLACEHOLDER`，没有 libopus，打断残留仍是 2400 ms。
- Metalio 固件补丁，以及工程机上的编译证据。基线 SHA 仍是 `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950`，本环境没有 ESP-IDF 编译。
- 生产级设备身份。认领码、短时 token 和 stub Basic 都是实验用的，不是量产身份。
- 真实 OV2710 采集。实验摄像头只用 1×1 PNG/JPEG 夹具。

`flash()` 和 `massFlash()` 仍然失败。`firmwareUrl` 仍是 null。

## 文档

- [docs/a0-firmware-baseline.md](docs/a0-firmware-baseline.md)
- [docs/a2-metalio-voice.md](docs/a2-metalio-voice.md)
- [docs/a4-claim-bind-ota.md](docs/a4-claim-bind-ota.md)
- [docs/lab-ota-config.md](docs/lab-ota-config.md)
- [docs/lab-voice.md](docs/lab-voice.md)
- [docs/lab-camera.md](docs/lab-camera.md)
- [docs/live-stub.md](docs/live-stub.md)
- [docs/a5-console-sim.md](docs/a5-console-sim.md)
- [docs/integration/b1.md](docs/integration/b1.md)
- [docs/integration/b2.md](docs/integration/b2.md)
- [docs/integration/b3.md](docs/integration/b3.md)
- [docs/eng-device/checklist.md](docs/eng-device/checklist.md)
