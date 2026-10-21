# 联合验收

这是用户锁定的端到端场景账本，给 Agent A 和 Agent B 并行用。它不是通过声明。

设备控制契约已冻结：`contracts/device-platform/device-control.openapi.yaml` 的 `info.version` 是 `v1`，健康检查 `maturity` 是 `v1-frozen`。字段名、路径前缀、头名称、错误码都不改。`OPENBOT_CONTRACT_SHA` 仍是 `d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f`。`routesAligned` 仍只表示 OpenBot OpenAPI 静态对齐。

`grayRelease`、`realDeviceDelivery`、`flash`、`massFlash` 保持关闭。`firmwareUrl` 保持 null。本进程不铸造 `authorizationRef`。绑定仍要先读 OpenBot `GET /grants/{authorizationRef}`。

UI、staging、真机、生产全部是 `JOINT_PENDING`。不要把 code-check 或 sim 写成端到端通过，也不要写成设备已经生效。

字段和调用顺序见 [device-control-api.md](../device-control-api.md)。本机 sim 见 [sim-joint-loopback.md](sim-joint-loopback.md)。

## 四个面

| 面 | 位置 | 这次仓库里有什么 |
|---|---|---|
| device-platform | `http://127.0.0.1:8791/api/device-platform/v1` | `npm run device-control`。配对、绑定、同步、本地停止 |
| OpenBot | `http://127.0.0.1:8787/api/integrations/v1` | 同意、`grants/exchange`、`GET /grants/{authorizationRef}`、rebind、revoke。stub 不在本仓库 |
| UI | OpenBot 管理端 | 「设备与硬件」、数字人详情「已连接设备」。本仓库没有这些页面 |
| hardware | 设备 | 真语音、拍照、烧录。不在 sim 里，也不在本仓库执行 |

`pairChallenge` 和 `pairingCode` 只出现在 device-platform。不要放进 `/api/integrations/v1`。

## 场景

1. 管理员登记设备平台，检查通过。
2. 用户在「设备与硬件」添加设备。
3. 绑定数字人 A。A 的「已连接设备」出现同一条记录。
4. 真语音对话，并拍照。只属于 real-device。sim 不做。
5. 在数字人详情把设备改绑到 B。两处记录一起更新。
6. 吊销。旧授权必须立刻不能再动作。

## 证据层

这五列不能并成一列。左边有结果，不代表右边有结果。

| 步骤 | code-check | sim | staging | real-device | production |
|---|---|---|---|---|---|
| 1. 登记设备平台且检查通过 | 健康检查与 capabilities 的单测：`maturity` 为 `v1-frozen`，`grayRelease` 与 `realDeviceDelivery` 为 false | sim / API-only：`GET /health` 与 `GET /capabilities`。见 sim loopback | `JOINT_PENDING` | `JOINT_PENDING` | `JOINT_PENDING`。不做生产登记 |
| 2. 「设备与硬件」添加设备 | 配对与核销单测。`pairingCode` 只返回一次 | sim / API-only：`pair-challenges` 然后 redeem。没有页面点击 | `JOINT_PENDING` | `JOINT_PENDING` | `JOINT_PENDING` |
| 3. 绑定数字人 A，两处看到同一条 | 单测把已核验 grant 写入绑定，`authorizationRef` 不在本地铸造 | sim / API-only：consent、exchange、bind、list 与 bind status 一致 | `JOINT_PENDING` | `JOINT_PENDING` | `JOINT_PENDING` |
| 4. 真语音 + 拍照 | 不适用。实验语音仍是占位，摄像头仍是 1×1 夹具 | 超出 sim | `JOINT_PENDING` | `JOINT_PENDING`。这一步只在真机阶段 | `JOINT_PENDING`。没有生产 OTA |
| 5. 改绑到 B，两处更新 | 单测里更高的 `bindingVersion` 走 `bind/sync`，`authorizationRef` 不变 | sim / API-only：OpenBot rebind 后 list 与 bind status 一起变 | `JOINT_PENDING` | `JOINT_PENDING` | `JOINT_PENDING` |
| 6. 吊销后旧授权立刻失败 | 单测：grant `status: revoked` 再同步，`bindStatus` 为 `revoked` | sim / API-only：OpenBot revoke 后 bind/sync 显示 revoked；旧 grant 再创建 conversation 失败 | `JOINT_PENDING` | `JOINT_PENDING` | `JOINT_PENDING` |

`npm test` 里的 sim joint 用例在进程内起一个只说冻结路由的 loopback，用来挡住 rebind 和 revoke 回退。它不是 openbot-vp 的 `:8787` stub。对着真 stub 要另跑 `npm run sim-joint`，凭证未设置时跳过。跳过不是 sim 通过，更不是 staging 通过。

## 三种证明

这三列也不能并进上面的证据层。接口返回 200，不等于页面能点，也不等于设备上已经生效。

| 步骤 | 管理页面可操作 | 服务接口可调用 | 设备实际已生效 |
|---|---|---|---|
| 1. 登记设备平台且检查通过 | `JOINT_PENDING`。本仓库没有管理端 | sim / API-only 能调用 health 与 capabilities。staging 与生产未做 | 不适用。登记本身不驱动硬件 |
| 2. 「设备与硬件」添加设备 | `JOINT_PENDING`。没有「设备与硬件」点击证据 | sim / API-only 能创建并核销配对挑战 | `JOINT_PENDING`。没有真实设备完成添加 |
| 3. 绑定数字人 A，两处看到同一条 | `JOINT_PENDING`。「已连接设备」没有页面证据 | sim / API-only：bind、list、bind status 使用同一 `authorizationRef` | `JOINT_PENDING`。设备侧没有确认已绑定 |
| 4. 真语音 + 拍照 | `JOINT_PENDING` | `JOINT_PENDING`。sim 不发起真实会话，也不上传真实照片 | `JOINT_PENDING`。没有喇叭出声，也没有传感器成像 |
| 5. 改绑到 B，两处更新 | `JOINT_PENDING`。数字人详情上的改绑没有页面证据 | sim / API-only：rebind 后 `bindingVersion` 增加，list 与 bind status 变成 B | `JOINT_PENDING`。设备没有改到 B 的运行态 |
| 6. 吊销后旧授权立刻失败 | `JOINT_PENDING`。页面上的吊销按钮没有证据 | sim / API-only：revoke 后 bind/sync 为 revoked，旧 grant 的 conversation 被拒绝 | `JOINT_PENDING`。设备没有证明已经停止动作 |

## 步骤落在哪一面

| 步骤 | device-platform `:8791` | OpenBot `:8787` | 仅 UI | 硬件 |
|---|---|---|---|---|
| 1 | `GET /health`，`GET /capabilities` | 管理端若要登记连接器，走 OpenBot 自己的管理接口。本契约不新增字段 | 管理员登记页、检查结果展示 | 无 |
| 2 | `POST /pair-challenges`，`POST /pair-challenges/{pairChallenge}/redeem` | 不接收 `pairChallenge` / `pairingCode` | 「设备与硬件」 | 无。真机认领不在 sim |
| 3 | `POST /devices/{deviceId}/bind`，`GET /devices`，`GET /devices/{deviceId}/bind` | `POST /consent/authorization-codes`（PKCE S256），`POST /grants/exchange`，`GET /grants/{authorizationRef}` | A 的「已连接设备」 | 无 |
| 4 | 无。不要在这里做真语音或拍照 | 会话、回合、run、媒体。冻结字段仍在 OpenBot | 对话与照片的展示 | 麦克风、扬声器、摄像头。只在 real-device |
| 5 | `POST /devices/{deviceId}/bind/sync`，然后再 list / bind status | `POST /grants/{authorizationRef}/rebind`，body 只有 `digitalHumanId` | 数字人详情上的改绑；A 与 B 两处列表 | 无 |
| 6 | `POST /devices/{deviceId}/bind/sync` 读到 `status: revoked` 后本地 `bindStatus` 为 `revoked`。`POST /revoke` 与 `POST /stop` 只停本平台，不代替 OpenBot 吊销 | `POST /grants/{authorizationRef}/revoke`。重复调用仍是 revoked。之后用旧 grant 开会话必须失败 | 吊销按钮与两处状态 | 设备停止出声、停止上传。只在 real-device |

绑定请求带 `X-OpenBot-Grant-Credential`。body 里的 `authorizationRef` 必须是 exchange 的返回值。

## 设备接入验收交接

交给「设备接入验收」时按下面这几条读，不要另作解释：

- 设备控制联合契约已冻结为 v1。请求和响应的字段名没有改，路径前缀、头名称、错误码也没有改。
- `OPENBOT_CONTRACT_SHA` 没有改，仍是 `d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f`。OpenBot OpenAPI 字节没有改。
- `grayRelease`、`realDeviceDelivery`、`flash`、`massFlash` 仍是 false。没有生产 OTA，没有批量烧录。
- code-check 与 sim / API-only 只证明服务接口这一列的一部分。管理页面可操作、设备实际已生效、staging、real-device、production 都是 `JOINT_PENDING`。
- 第 4 步真语音和拍照超出 sim，不能勾。
- Agent B 可以按冻结的 device-control OpenAPI 并行做 UI。Agent A 的 sim 命令是 `npm run sim-joint`。凭证未设置时的跳过，不能写进验收通过记录。
- 验收要另收：管理端操作记录、staging 调用记录、真机上的语音和照片、设备侧已经生效的证据。本文件不代替那些证据。
