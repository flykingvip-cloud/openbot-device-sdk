# 模拟联合 loopback

只在本机跑。每一项都是 **sim / API-only**。

管理页面可操作：`JOINT_PENDING`。设备实际已生效：`JOINT_PENDING`。staging、real-device、production：`JOINT_PENDING`。真语音和拍照不在这里。`grayRelease` 与 `realDeviceDelivery` 保持 false。不调用 `flash` 或 `massFlash`。

场景账本见 [joint-acceptance.md](joint-acceptance.md)。设备控制字段见 [device-control-api.md](../device-control-api.md)。OpenBot stub 的口令位置见 [live-stub.md](../live-stub.md)。

## 两个进程

| 进程 | 地址 | 怎么来 |
|---|---|---|
| OpenBot stub | `http://127.0.0.1:8787` | openbot-vp 的 loopback。`GET /healthz` 在根上。能力在 `/api/integrations/v1` |
| device-control | `http://127.0.0.1:8791` | `npm run sim-joint` 拉起，检查结束就关。长驻用 `npm run device-control -- --listen 127.0.0.1:8791` |

`npm run sim-joint` 占用 8791。先别另开一个 device-control 听同一端口。

进程内单测会另起一个只实现冻结路由的 loopback，用来断言 rebind 和 revoke。那个 stand-in 不是 openbot-vp 的 stub，也不能当成 `:8787` 已经联调通过。

## 环境变量

口令只从 openbot-vp 合约针 `d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f` 的 `docs/integrations/device-digital-human/staging.md` 抄进环境。本仓库不写值，也不编造用户名。

| 名字 | 用在 |
|---|---|
| `OPENBOT_DEVICE_DH_STUB_URL` | OpenBot stub，示例 `http://127.0.0.1:8787` |
| `OPENBOT_STUB_SERVICE_USER` | service Basic |
| `OPENBOT_STUB_SERVICE_PASSWORD` | service Basic |
| `OPENBOT_STUB_CONSENT_USER` | consent Basic |
| `OPENBOT_STUB_CONSENT_PASSWORD` | consent Basic |
| `OPENBOT_DEVICE_DH_STUB_ID` | 数字人 A |
| `OPENBOT_STUB_DEVICE_ID` | `deviceId` |
| `OPENBOT_STUB_SERVICE_AUDIENCE` | consent 的 `serviceAudience` |
| `OPENBOT_STUB_REDIRECT_URI` | consent 与 exchange 的 `redirectUri` |
| `OPENBOT_STUB_SCOPES` | 逗号分隔的 `scopes` |
| `OPENBOT_STUB_AUTH_STATE` | consent 的 `state` |
| `OPENBOT_STUB_CODE_VERIFIER` | PKCE verifier，43 到 128 字符。consent 只带它的 S256 `codeChallenge` |

不要设置 `OPENBOT_STUB_AUTHORIZATION_CODE`。这条路径自己做 consent，再 exchange。`authorizationRef` 只用 exchange 的返回值，本地不铸造。

未传 `--digital-human-b` 时，rebind 仍用数字人 A，只要求 `bindingVersion` 增加。用户场景里的「改绑到 B」要显式传入 B，并且 B 必须已经在同一 stub 的配置里。

## 命令

凭证不齐时只打印跳过，不访问网络。跳过不是通过。

```bash
npm run sim-joint
```

凭证齐、stub 已在 8787 时：

```bash
OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787 \
OPENBOT_STUB_SERVICE_USER=... \
OPENBOT_STUB_SERVICE_PASSWORD=... \
OPENBOT_STUB_CONSENT_USER=... \
OPENBOT_STUB_CONSENT_PASSWORD=... \
OPENBOT_DEVICE_DH_STUB_ID=... \
OPENBOT_STUB_DEVICE_ID=... \
OPENBOT_STUB_SERVICE_AUDIENCE=... \
OPENBOT_STUB_REDIRECT_URI=... \
OPENBOT_STUB_SCOPES=... \
OPENBOT_STUB_AUTH_STATE=... \
OPENBOT_STUB_CODE_VERIFIER=... \
npm run sim-joint -- --digital-human-b ...
```

`...` 是占位，不是可用口令。

## 顺序

下面每一步都是 sim / API-only。`BASE_D=http://127.0.0.1:8791/api/device-platform/v1`，`BASE_O=http://127.0.0.1:8787/api/integrations/v1`。service Basic 记为 `$SERVICE`，consent Basic 记为 `$CONSENT`。`codeChallenge` 是 verifier 的 S256，不要把 verifier 发给 consent。

1. sim / API-only。`GET $BASE_D/health` 与 `GET $BASE_D/capabilities`。`maturity` 为 `v1-frozen`。`grayRelease`、`realDeviceDelivery`、`flash`、`massFlash` 为 false，`firmwareUrl` 为 null。`openBot.pairFieldsAccepted` 为 false。
2. sim / API-only。`POST $BASE_D/pair-challenges`，body 只有 `{ "deviceId" }`。留下 `pairChallenge` 和一次性 `pairingCode`。
3. sim / API-only。`POST $BASE_D/pair-challenges/{pairChallenge}/redeem`，body 只有 `{ "deviceId", "pairingCode" }`。`ownership` 为 `verified`（sim 配对码持有验证 / simulation possession verification，非真机硬件归属）。响应里不再出现 `pairingCode`。
4. sim / API-only。`POST $BASE_O/consent/authorization-codes`，只有 consent Basic。body 只有 `serviceAudience`、`redirectUri`、`codeChallenge`、`codeChallengeMethod`（`S256`）、`digitalHumanId`、`deviceId`、`scopes`、`state`。不送 `pairChallenge` 或 `pairingCode`。
5. sim / API-only。`POST $BASE_O/grants/exchange`，service Basic 和 `Idempotency-Key`。body 只有 `authorizationCode`、`codeVerifier`、`redirectUri`。同一 stub 必须立刻能 `GET $BASE_O/grants/{authorizationRef}`。读不到就停，不要另造一个 `authorizationRef`。
6. sim / API-only。`POST $BASE_D/devices/{deviceId}/bind`。头 `X-OpenBot-Grant-Credential` 用 exchange 返回的 `authorizationCredential`。body 只有 `{ "authorizationRef" }`。
7. sim / API-only。`GET $BASE_D/devices` 和 `GET $BASE_D/devices/{deviceId}/bind`。两条都是 `bindStatus: bound`，`authorizationRef`、`bindingVersion`、`digitalHumanId` 相同。列表里没有 `pairingCode`。
8. sim / API-only。`POST $BASE_O/grants/{authorizationRef}/rebind`，只有 consent Basic，body 只有 `{ "digitalHumanId" }`。`authorizationRef` 不变，`bindingVersion` 增大。旧的 `bindingVersion` 不能再拿去发回合或工具结果。
9. sim / API-only。`POST $BASE_D/devices/{deviceId}/bind/sync`，仍是同一个 `authorizationRef` 和同一把 grant 凭证。然后再 list 和 bind status。两处都变成新的 `bindingVersion` 和 `digitalHumanId`。
10. sim / API-only。`POST $BASE_O/grants/{authorizationRef}/revoke`，service Basic 加 grant 凭证。再调一次仍是 `status: revoked`。
11. sim / API-only。`POST $BASE_D/devices/{deviceId}/bind/sync`。`bindStatus` 为 `revoked`，`revoked` 为 true。list 与 bind status 一致。
12. sim / API-only。用旧 grant 再 `POST $BASE_O/conversations`，body 用已有字段 `authorizationRef`、`deviceId`、`bindingVersion`。必须不是 2xx。这只说明接口拒绝，不说明设备已经停。

对应 curl 形状：

```bash
curl -sS -u "$OPENBOT_STUB_SERVICE_USER:$OPENBOT_STUB_SERVICE_PASSWORD" \
  "http://127.0.0.1:8791/api/device-platform/v1/health"

curl -sS -u "$OPENBOT_STUB_SERVICE_USER:$OPENBOT_STUB_SERVICE_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"deviceId":"'"$OPENBOT_STUB_DEVICE_ID"'"}' \
  "http://127.0.0.1:8791/api/device-platform/v1/pair-challenges"
```

同意、exchange、rebind、revoke 的字段以上面的顺序为准，不要加配对字段。`npm run sim-joint` 用仓库里的客户端按这个顺序断言，避免手写 PKCE 时把 verifier 送到 consent。

## 断言标签

脚本打印的每一行都带 `sim / API-only`。成功时还会打印：

- `maturity: v1-frozen`
- `bindingVersion` 从小到大
- revoke 之后 `bindStatus: revoked`
- 旧 grant 的 conversation HTTP 状态不是 2xx
- `JOINT_PENDING: UI、staging、real-device、production`

不会打印 service 口令、consent 口令或 `authorizationCredential`。

## 不在这次 sim 里

- 「设备与硬件」和「已连接设备」的点击
- staging 主机
- 真语音、真拍照、扬声器、麦克风、摄像头
- 生产，以及任何烧录
