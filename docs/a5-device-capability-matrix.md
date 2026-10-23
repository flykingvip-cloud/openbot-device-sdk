# A5 设备能力矩阵与 adapter 槽位

Plan A 切片 **A5**：为后续录音卡（record-card）落地声明 **设备能力矩阵** 与 **adapter 家族槽位**。本切片只做类型 + 文档 + `adapters/record-card` 占位，**不**实现完整录音卡，**不**改冻结的 device-control v1 OpenAPI，**不**改合约 / 固件针，**不**连接 `api.tenclass.net`。

> 注意：仓库里既有的 [a5-console-sim.md](a5-console-sim.md) 是更早的「实验控制台 / 模拟器」文档，与本切片同名编号无关。本文件专指 Plan A 的 **capability matrix**。

## 能力键

每个设备家族 profile 必须声明：

| 键 | 含义 |
|---|---|
| `mic` | 麦克风 / 采集上行 |
| `storage` | 本地或暂存存储（分区、文件、录音落盘） |
| `ble` | 蓝牙（若硬件有） |
| `usb` | USB（调试 / 大容量 / CDC 等） |
| `speaker` | 扬声器 / 播放路径；**可选** |

`speaker` 与 `ttsPlayback` 分开：硬件可以有喇叭，产品仍可把 TTS 标成 `optional` / `unsupported`。录音卡 profile 默认 `ttsPlayback: unsupported`。

## Adapter 家族槽位

| 槽位 | 路径 | Opus 角色 | A5 状态 |
|---|---|---|---|
| `metalio` | `adapters/metalio` | **broadcast-frame** | implemented |
| `record-card` | `adapters/record-card` | **recording-storage** | placeholder（仅 README） |
| `generic` | `adapters/generic`（未建） | none | planned |

类型与预设：`sdk/src/device-capabilities.ts`（经 `sdk/src/index.ts` 导出）。

## 两套 Opus 语义（强化）

| 语义 | 用途 | 采样 / 封装 | 本仓位置 |
|---|---|---|---|
| **播报帧 Opus**（broadcast-frame） | metalio 实时 TTS / 语音 WS 下行（裸包，非 Ogg） | hello 默认 **24 kHz / mono / 60 ms** | `adapters/metalio` + `OpusFrameEncoder` / `TtsProvider` |
| **录音存储 Opus**（recording-storage） | 录音卡等高码率落盘（常 ~256 kbps / Ogg 等） | **不得**复用 metalio hello 常量 | 预留 `adapters/record-card` |

改 hello 采样率须书面一次；不搞 16k/24k 双标准验收口径。录音卡实现不得把播报帧常量拷进存储路径。

## 与 device-control v1 的边界

- 冻结前缀仍是 `/api/device-platform/v1`，`maturity: v1-frozen`。
- **BLE / USB / mic / storage / speaker 只出现在本矩阵与文档**，不得写入 `contracts/device-platform/device-control.openapi.yaml`，也不得新增 DC 路由。
- `GET .../capabilities` 仍是服务端控制面能力（audience / auth / routes / OTA 开关），**不是**设备硬件矩阵。
- OpenBot grant 上的 `PUT .../device-capabilities` 属 integrations 契约，本切片不改。

## 预设 profile

| `profileId` | Adapter | mic | storage | ble | usb | speaker | ttsPlayback |
|---|---|---|---|---|---|---|---|
| `metalio-claw-4` | metalio | true | true | optional | optional | optional | optional |
| `record-card-generic` | record-card | true | true | optional | optional | optional | unsupported |

查询辅助：`listDeviceCapabilityMatrices()`、`getDeviceCapabilityMatrix(profileId)`、`listAdapterFamilySlots()`、`isSpeakerOptional(matrix)`。

## 下一步（A6）

- Gateway upload 示例文档 + voice harness（仍不把 upload HTTP 塞进本 SDK / DC v1）
- record-card 真实现另开切片，不在本 PR

## 不做的事

- 不实现完整 record-card
- 不改 device-control v1 OpenAPI / 路由
- 不改 `OPENBOT_CONTRACT_SHA` / `FIRMWARE_SHA`
- 不连接 `api.tenclass.net`
