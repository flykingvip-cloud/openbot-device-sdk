# A4 认领、绑定与 OTA 控制面

`services` 里的 `ControlPlane` 是实验控制面。不传 `store` 时状态在内存里。传入文件或 sqlite 的 `StagingDb` 后，认领、绑定、实验 OTA、短时凭证和吊销可以在新进程里读回。控制面本身不下载固件，不写设备分区。另有一个实验配置 HTTP，见 [lab-ota-config.md](lab-ota-config.md)。控制台用法见 [a5-console-sim.md](a5-console-sim.md)。

## 认领

1. `issueClaim(deviceId)` 发出 6 位数字码，10 分钟有效。这和手册里的 6 位绑定码同一长度，但不是小智云 `/activate`。
2. `redeemClaim(deviceId, code)` 把该设备标成已认领。过期、重复、错码都拒绝。

## 绑定

已认领的设备才能 `bind`。写入的字段名固定为：

- `authorizationRef`：服务端生成，调用方不能指定
- `bindingVersion`：首次为 1
- `digitalHumanId`
- `deviceId`
- `assistant`：JSON 对象，`assistant.*` 原样保存

`rebind` 会换新的 `authorizationRef`，并把 `bindingVersion` 加 1。`deviceId` 不变。字段名仍是 `assistant`，但新授权里的资料会替换原来的值。换成另一个 `digitalHumanId` 时必须带上新的 `assistant`。调用方不能指定 `deviceId`、`authorizationRef` 或 `bindingVersion`。别名（`device_id`、`assistantProfile` 等）也会拒绝。rebind 会清掉 B1 资料缓存，并关掉这台设备上还开着的会话。

## OTA

`proposeLabOta` 只给一台已经绑定的设备记一条版本记录：

- `force` 只能是 0
- `firmwareUrl` 必须为空
- `executable` 固定 false
- `scope` 固定 `single-device`
- `rollout` 固定 `lab-record-only`

下面这些调用都会失败：

- `flash()`、`massFlash()`
- `force: 1`
- 任何固件 URL，包括 `api.tenclass.net` 和设置页里写死的 C5 包主机 `cloudzaoai.oss-rg-china-mainland.aliyuncs.com`
- `rollout` 为 `production`、`mass` 或 `fleet`
- `scope` 不是单设备

B5 stand-in `GET /v1/device/ota` 的 `flash` 也是 false。当前针的 OpenAPI 在本环境是 404，不能把 stand-in 或实验配置 HTTP 当成线上 OTA。配置响应里的 `firmwareUrl` 同样是 null。

## 与固件 OTA 的边界

Metalio 自己的 `Ota::Upgrade` 会 GET `firmware.url` 并写入下一分区。本控制面不产生这个 URL，因此不能驱动量产升级，也不能批量烧录。

## 重连与吊销

`issueConnectionCredential` 给已绑定设备发一个短时 token。`refreshConnectionCredential` 是本地 stub：只在当前 token 仍有效且设备未吊销时轮换它，不访问网络。过期 token 可以刷新，但不能用来提交摄像头结果。

`revoke` 清掉该设备的短时 token，并留下吊销标记。冻结字段名不动。吊销之后到达的摄像头结果一律 `camera_revoked`，不管 `capturedAtMs` 是不是更早。吊销同时关掉该设备还开着的会话，旧会话上的 append / pull 不再进入原来的 run。`rebind` 会丢掉剩余 token、清掉吊销标记、轮换 `authorizationRef`，并同样关掉旧会话。
