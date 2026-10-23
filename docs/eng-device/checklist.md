# 设备工程清单

日常仓库只使用 <https://github.com/flykingvip-cloud/openbot-device-sdk>。不要克隆 `upbeyond/openbot-device-sdk`。

## 合约

- [ ] `contracts/OPENBOT_CONTRACT_SHA` 为 `d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f`
- [ ] 文档写明这是 openbot-vp `main` 上 PR #17 的 squash merge
- [ ] `previousSha` 为已作废的 PR #16 squash `490a69669c0cf9e68173ceb25cfa89c99438dfb9`，它不是 `officialMergeSha`
- [ ] `feeac51863d6d88ba83c7e16029b2911209bb0d0`、`fe1e2c2a81fd3814e8588a854695640ca56db64b`、`92826116a9b00a596ae2360d8a643d6148050e3c`、`d22db4755311a1a0df9fb5e3d5da60554f8ef6a5`、`bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a`、`41b7561222775e4ad00b056e2a535c7f950bcbe9`、`536a963b119f0a00675516401c52dd0f6187b196`、`8abdc7f9a0ae49c340de712fbba235b1064f6c7d`、`554910d835f3baadb1d753532ad510b1b477be09` 与 `dd6c85cae086d90c519ff1be7ad08e20d4644bba` 仍在 `invalidatedShas` 里
- [ ] 仓库是 `flykingvip-cloud/openbot-vp`，不是 `upbeyond/openbot`
- [ ] 没有把作废短针 `68e062e` 写回依赖
- [ ] `contracts/openbot/device-digital-human.openapi.yaml` 仍是路径对齐用的入库字节；PR #17 未改冻结字段名和前缀。路径和 SSE 事件名一致时 `routesAligned` 为 true。该标志只表示静态对齐，不是端到端联调通过
- [ ] 实验配置带 `gatewayAgentId`；默认会话键是 `device-dh:<digitalHumanId>:<conversationId>`；只有 `OPENBOT_DEVICE_DH_AGENT_SESSION_FORCE=1` 才接受 UI 会话键
- [ ] B1 live GET 使用 `/api/integrations/v1/digital-humans/{digitalHumanId}`；B0 与 B2–B5 的本地 stand-in 仍在
- [ ] `npm run live-stub` 只对 loopback 的 `GET /healthz`（根路径）和可选的数字人 / 合成图摄像头发请求
- [ ] 冻结字段仍是 `authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`、`assistant.*`
- [ ] 未设置 `OPENBOT_DEVICE_DH_STUB_URL` 时不访问 live stub；未设置 service Basic 和 grant 时跳过数字人与摄像头 live 用例

## A2 语音

- [ ] 固件 SHA 仍是 `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950`
- [ ] 客户端 hello 仍是 websocket + Opus 16 kHz / 单声道 / 60 ms，`features.mcp=true`
- [ ] 协议 version 2 / 3 的二进制头长度仍是 16 和 4
- [ ] 默认 mock 下行仍带 `OB-OPUS-PLACEHOLDER`；真 Opus 仅经注入的 `TtsProvider` / `OpusFrameEncoder`（`@evan/opus`），不连 api.tenclass.net
- [ ] 占位 / mock 路径：打断可不调用 ResetDecoder；满队列残留文档化为 ≤ 40 × 60 ms = 2400 ms（**非**真 TTS 最终门闩）
- [ ] 真 TtsProvider 路径（A4）：AbortSpeaking 清解码队列 / ResetDecoder；lab 断言 `queueCleared`，`residualMs === 0`；不以 2400 ms 作最终 eng 门闩
- [ ] 没有把 `api.tenclass.net` 配成语音或 OTA 生产入口
- [ ] AsrProvider / TtsProvider 可注入（A1）；默认仍是 mock。真实 ASR / TTS 权重与厂商在包外。默认 TTS 仍是 `OB-OPUS-PLACEHOLDER`。未设置 stub 时 `finishUtterance` 标明 sim；配了 loopback stub 也只消费 visible/final，不是端到端通过
- [ ] ASR 双模式（方案 A3）：整段 WAV/PCM → `transcribe`（WAV 采样率来自文件头）；流式 `stream` partial/final 可测（mock stub 或外部 FunASR）。不捆绑权重；不进 device-control v1；upload HTTP 不在本包
- [ ] 未设置 `OPENBOT_LAB_VOICE_WSS_URL` 时，实验配置里的 voice WSS 仍是 `wss://lab.invalid/voice`

## A3 媒体与工具

- [ ] 屏的运行时格式仍按 RGB888、24 bpp、3 块 720×720 缓冲记录；1,036,800 只作为 RGB565 算术
- [ ] 数字人表情仍收敛到 6 类；聊天表情仍用原始名字加 `.eaf`
- [ ] 摄像头描述仍是 OV2710 / 预览裁剪 720×600 / JPEG 360×300 质量 55，且 `media.describe` 仍是 describe-only
- [ ] 设备端摄像头采集仍未实现；实验闭环只用 1×1 PNG/JPEG 夹具，不打开 OV2710
- [ ] 实验上传只走本地 stand-in 或 `OPENBOT_DEVICE_DH_STUB_URL`，不是生产上传主机
- [ ] `system.reboot` 不能从 B3 发出

## A4 控制面

- [ ] 认领码是 6 位，绑定前必须先认领
- [ ] rebind 更换 `authorizationRef`、递增 `bindingVersion`；`assistant` 字段名不变，新资料替换旧值
- [ ] `flash()` 与 `massFlash()` 仍然抛错
- [ ] 实验 OTA 记录和配置 HTTP 的 `firmwareUrl` 仍是 null，`force` 仍是 0
- [ ] 设备固件烧录仍未实现
- [ ] `npm run ota-config` 的公开配置只有非敏感 URL 和配对提示；token 只在核验设备身份后签发；进程不广告 grants / conversations / runs；默认只绑 loopback
- [ ] `/api/device-platform/v1` 已冻结为 v1（`info.version: v1`，`maturity: v1-frozen`）。字段名未改。不是灰度，也不是真机交付；`pairChallenge` / `pairingCode` 不进入 `/api/integrations/v1`；`flash()` 与 `massFlash()` 仍然失败
- [ ] [docs/integration/joint-acceptance.md](../integration/joint-acceptance.md) 把 code-check、sim、staging、real-device、production 分开，也把管理页面、服务接口、设备生效分开。UI、staging、真机、生产仍是 `JOINT_PENDING`
- [ ] [docs/integration/sim-joint-loopback.md](../integration/sim-joint-loopback.md) 的每一项都是 sim / API-only。`npm run sim-joint` 在凭证未设置时跳过，跳过不是通过
- [ ] 拒绝量产、批量、fleet，以及十班和 C5 托管包主机
- [ ] `npm test` 与 `npm run typecheck` 为绿

## A5 控制台与重连

- [ ] `npm run console` 与 `npm run sim` 能在无工程机时跑完
- [ ] 状态文件用 sqlite 或 JSON，重启后绑定、吊销和实验 OTA 还在
- [ ] refresh 不访问网络；吊销清空短时 token
- [ ] 吊销之后的摄像头结果仍是 `camera_revoked`
- [ ] B2 stand-in 覆盖幂等、`SESSION_BUSY`、`CURSOR_EXPIRED`、`eventId` 去重
- [ ] B3 TTS 只包含 `assistant.visible.speech`
- [ ] `flash()` 与 `massFlash()` 仍然失败，没有活的固件 URL


## Plan A A5 能力矩阵（与控制台 A5 文档区分）

- [ ] `sdk/src/device-capabilities.ts` 声明 mic/storage/ble/usb/speaker（speaker 可选）与 adapter 槽位 metalio / record-card / generic
- [ ] 播报帧 Opus vs 录音存储 Opus 在类型 `OpusSemanticRole` 与 [docs/a5-device-capability-matrix.md](../a5-device-capability-matrix.md) 中分开；record-card 仅为占位
- [ ] BLE/USB 等本地能力**未**写入 `contracts/device-platform/device-control.openapi.yaml`，未改 DC v1 路由
- [ ] `OPENBOT_CONTRACT_SHA` / `FIRMWARE_SHA` 未改；无 `api.tenclass.net` 生产入口

## Plan A A6 gateway upload 文档 + voice joint harness

- [ ] [docs/integration/claw4-gateway-upload.md](../integration/claw4-gateway-upload.md) 指向 openbot-vp `docs/integrations/device-digital-human/claw4-firmware-http-compat.md`；主路径 stub `:8787`；gateway `:18789` 无 DeviceDhService 时 503
- [ ] 鉴权写明 Basic + `X-OpenBot-Grant-Credential` + `X-Device-Id`(=grant.deviceId)；`data.text` = ASR/passthrough 非 assistant.final
- [ ] `examples/claw4-upload-curl.sh` 与 `npm run voice-joint` 存在；凭证缺失时跳过，跳过不是通过
- [ ] **未**扩展 `npm run sim`；upload **未**写入 device-control OpenAPI；pin / DC OpenAPI 字节未改
- [ ] 双命令姿势：`device-control` + `voice`（可选）+ `voice-joint` 文档化

## 验收阻断

这些仍未完成。勾上任何一项都不表示 A0–A5 已经灰度。

- [ ] 真实 Opus / ASR / TTS（不是 `OB-OPUS-PLACEHOLDER`）
- [ ] 工程机上的 Metalio 固件补丁和编译证据
- [ ] 生产级设备身份
- [ ] 真实 OV2710 采集
