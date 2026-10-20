# 设备平台配对与设备控制 API

这是给 Agent B 冻结字段用的草稿。它不是灰度发布，也不是真机交付。`flash()` 和 `massFlash()` 仍然失败，这里不打开生产 OTA。

OpenBot 的冻结契约仍是 `/api/integrations/v1`。当前针是 `92826116a9b00a596ae2360d8a643d6148050e3c`（openbot-vp PR #12）。冻结字段名没有改。OpenAPI 里没有配对挑战字段，也没有客户端注册接口。

设备归属和一次性配对挑战由设备平台在进入 OpenBot 授权流程之前完成。连接器不得把 `pairChallenge`、`pairingCode`、`pairingChallenge`、`ownershipProof` 或 `pairNonce` 放进 `/api/integrations/v1` 的请求。

## 边界

| 步骤 | 在哪里 | 用什么 |
|---|---|---|
| 发现能力、健康检查 | 设备平台 `/api/device-platform/v1` | service Basic |
| 创建并核销一次性配对挑战 | 设备平台 | service Basic。响应里的 `pairingCode` 只出现一次 |
| 用户同意 | OpenBot `POST /api/integrations/v1/consent/authorization-codes` | consent Basic，PKCE S256。body 只有冻结字段 |
| 兑换 grant | OpenBot `POST /api/integrations/v1/grants/exchange` | service Basic。`authorizationRef` 由 OpenBot 返回 |
| 应用绑定 | 设备平台 `POST /devices/{deviceId}/bind` | service Basic + `X-OpenBot-Grant-Credential`。只接受上面兑换到的 `authorizationRef` |
| 状态、同步 | 设备平台 | 同步会再读 OpenBot grant |
| 停止 | 设备平台 `POST /devices/{deviceId}/stop` 或 `/revoke` | 只停本平台。OpenBot 吊销仍走 `/grants/{authorizationRef}/revoke` |

服务客户端不能自己声明 `userId`、`tenantId` 或 `userSubject`。`digitalHumanId` 只有作为 grant 回声出现时才接受，而且必须和 OpenBot grant 一致。设备平台不铸造 `authorizationRef`。

实验 OTA 配置 HTTP（`npm run ota-config`）是另一进程，给设备和模拟器读公开配置。它不提供这组设备控制路由。

字段、状态码和调用顺序见 [device-control-api.md](device-control-api.md)。OpenAPI 在 `contracts/device-platform/device-control.openapi.yaml`。
