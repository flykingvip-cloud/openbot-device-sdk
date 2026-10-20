# 设备控制 HTTP

前缀：`/api/device-platform/v1`。

这是给 OpenBot 服务客户端用的草稿，供 Agent B 冻结字段。不是灰度，也不是真机交付。默认只监听 loopback。`firmwareUrl` 为 null。没有 `flash` 或 `massFlash` 路由。

```bash
OPENBOT_STUB_SERVICE_USER=... OPENBOT_STUB_SERVICE_PASSWORD=... npm run device-control -- --listen 127.0.0.1:8791
```

未设置 service Basic 时进程不启动。绑定和状态同步还要能读到 OpenBot grant：设置 `OPENBOT_DEVICE_DH_STUB_URL`，并在请求里带 `X-OpenBot-Grant-Credential`。读不到 grant 时返回 `grant_unverified` 或 `grant_unreachable`，不会本地铸造 `authorizationRef`。

OpenAPI：`contracts/device-platform/device-control.openapi.yaml`。

## 认证

`Authorization: Basic`，用户名是服务主体 `servicePrincipal`。口令来自 `OPENBOT_STUB_SERVICE_USER` / `OPENBOT_STUB_SERVICE_PASSWORD`，与 OpenBot `serviceBasic` 相同。未认证返回 `401 unauthorized`。

浏览器提交的 `userId`、`tenantId`、`userSubject` 返回 `400 untrusted_identity`。

## OpenBot UI 调用顺序

1. `GET /api/device-platform/v1/health` 和 `GET /api/device-platform/v1/capabilities`。确认 `openBot.pairFieldsAccepted` 为 false，`grayRelease` 为 false，`realDeviceDelivery` 为 false。
2. `POST /api/device-platform/v1/pair-challenges`，body 只有 `{ "deviceId": "dev-1" }`。响应 `201`：`pairChallenge`、`pairingCode`（6 位，只此一次）、`expiresAtMs`、`status: pending`。
3. `POST /api/device-platform/v1/pair-challenges/{pairChallenge}/redeem`，body `{ "deviceId", "pairingCode" }`。响应没有 `pairingCode`。`ownership` 为 `verified`，`servicePrincipal` 是 Basic 用户名。
4. 到 OpenBot 做同意和兑换。同意 body 使用 PKCE S256 和冻结字段：`serviceAudience`、`redirectUri`、`codeChallenge`、`codeChallengeMethod`、`digitalHumanId`、`deviceId`、`scopes`、`state`。不要附带 `pairChallenge` 或 `pairingCode`。兑换 `POST /api/integrations/v1/grants/exchange` 返回 `authorizationRef` 和一次性 `authorizationCredential`。
5. `POST /api/device-platform/v1/devices/{deviceId}/bind`。头 `X-OpenBot-Grant-Credential`。body 必填 `authorizationRef`，必须等于兑换结果。可选回声 `bindingVersion`、`digitalHumanId`、`deviceId`，不一致则 `409`。服务端再读 grant，存下 grant 里的 `authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`、`assistant`。`source` 为 `openbot-grant`。
6. `GET /api/device-platform/v1/devices` 或 `GET /api/device-platform/v1/devices/{deviceId}/bind` 看状态。列表里没有 `pairingCode`。
7. OpenBot rebind 提高 `bindingVersion` 之后，`POST .../bind/sync` 用同一个 `authorizationRef` 再读 grant。本地不换新的 `authorizationRef`。
8. 停止用 `POST .../stop` 或 `POST .../revoke`。这只清本平台短时 token 并把 `bindStatus` 设为 `revoked`。OpenBot 侧吊销仍是 `POST /api/integrations/v1/grants/{authorizationRef}/revoke`。本地停止会保留，直到同步到更高的 `bindingVersion`，或 grant 本身已是 `revoked`。

## 响应字段

设备对象：

- `deviceId`
- `servicePrincipal`
- `ownership`：`pending` 或 `verified`
- `bindStatus`：`unbound`、`bound` 或 `revoked`
- `revoked`
- `pairChallenge`：仅在挑战仍 pending 时出现，不含配对码
- `authorizationRef`、`bindingVersion`、`digitalHumanId`、`assistant`：来自已核验的 OpenBot grant
- `source`：`openbot-grant`

健康检查：

- `maturity`：`agent-b-freeze-draft`
- `grayRelease`：false
- `realDeviceDelivery`：false
- `flash`：false
- `massFlash`：false
- `firmwareUrl`：null

错误体是 `{ "error", "message" }`。常见 `error`：`unauthorized`、`untrusted_identity`、`pair_field`、`pair_code`、`pair_expired`、`pair_owned`、`pair_missing`、`grant_credential`、`grant_ref`、`grant_mismatch`、`grant_device`、`grant_unverified`、`grant_unreachable`、`bind_revoked`、`not_device_platform`。

`/api/integrations/v1` 打到这个进程上是 `404 not_device_platform`。
