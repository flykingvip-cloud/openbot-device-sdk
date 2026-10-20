# 设备控制 API（给 OpenBot UI）

这是设备平台自己的实验 HTTP，默认只监听 loopback。它不是 `/api/integrations/v1`，也不把配对字段写进 OpenBot 契约。

纵向连接器（grant exchange、会话、回合、SSE、工具结果）在草稿 PR #10。本接口不调用那份尚未合并的代码。PR #10 合并之前，这里只记录 OpenBot 交来的 `authorizationRef` 和 `bindingVersion`，不在本地另造一把。

生产 OTA 和批量刷机没有打开。`firmwareUrl` 恒为 null。`flash` / `massFlash` 不在能力列表里。

## 鉴权

调用方是服务客户端的 HTTP Basic：

- `OPENBOT_DEVICE_CONTROL_SERVICE_USER`
- `OPENBOT_DEVICE_CONTROL_SERVICE_PASSWORD`（至少 16 字符）

Basic 里的 client id 就是服务主体。请求体和查询字符串里的 `userSubject`、`tenantId`、`digitalHumanId`、`userId`、`initiator` 会被拒绝。浏览器不能自己声明用户、租户或数字人。

## 给 Agent B 冻结的三条「设备与硬件」草稿

| id | 名称 | 覆盖 |
|---|---|---|
| `device-control.discover` | 设备发现 | `GET /health`、`GET /capabilities` |
| `device-control.pair` | 设备配对 | 一次性配对挑战、按服务主体列出和查询设备 |
| `device-control.control` | 绑定与状态 | 应用绑定、查询状态、停止/撤销、状态同步 |

名字是草稿，等 Agent B 冻结。OpenAPI 在 `contracts/device-control/openapi.yaml`。前缀是 `/api/device-control/v1`。协议版本是 `device-control.v1`。

## 配对挑战

`POST /pair-challenges` 的正文只有 `deviceId`。发起人取自已认证的服务客户端，不取自正文。挑战绑定这一对发起人和设备，默认 60 秒，密钥只在创建时返回一次。

`POST /pair-challenges/{challengeId}/verify` 核对 `deviceId` 和 `secret`。失败累计次数，3 次后锁定。过期、锁住、已使用、换设备、换服务主体都不能通过。成功之后该设备才出现在这个服务主体的列表里。

## 应用绑定

`POST /devices/{deviceId}/binding` 接收：

- `authorizationRef`：OpenBot grant 引用，原样保存
- `bindingVersion`：整数，至少为 1
- `restrictedAuth`：至少 16 字符的不透明凭证，保存但不回显

状态顺序是 `accepted` → `applying` → `active`。字段不合法时记为 `failed`。未配对或已停止时拒绝。`GET` 同一路径查询当前状态。

## 停止 / 撤销

`POST /devices/{deviceId}/revoke` 停下本记录里的会话、播放和工具，并清掉 `restrictedAuth`。如果同一 `deviceId` 在实验控制面里已经绑定，同时撤销那里的短时连接凭证并关掉会话监听。不烧录。

## 状态同步

`POST /devices/{deviceId}/status` 接收 `eventId`、`version`、`online`、`lastSeen`、`capabilities`、`firmware`。

- 同一 `eventId` 加同一份正文是重复，返回已保存的快照，`duplicate: true`
- 同一 `eventId` 换正文是 `status_conflict`
- 新的 `eventId` 必须使用更大的 `version`，否则是 `status_version`
- `firmware` 只是标签。`firmwareUrl`、带 `://` 的固件值、`ota.flash`、`ota.massFlash` 都拒绝
- 响应里的 `firmwareUrl` 仍是 null

## 启动

```bash
npm run device-control -- --help
```

这不是灰度，也不是真机交付。
