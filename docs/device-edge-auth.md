# Device → edge → OpenBot auth（可跑 lab proxy）

两跳。**固件不得烧平台 / integrations service Basic。**

```
device  --(per-device creds)-->  SDK edge  --(service Basic + grant + X-Device-Id)-->  OpenBot
```

## Hop 1 — device → SDK edge

- Lab today: claim / redeem → short-lived **connection token** from the local control plane (`issueConnectionCredentialWithProof`, OTA config credentials HTTP). See [docs/a4-claim-bind-ota.md](a4-claim-bind-ota.md).
- Product later: device identity, mTLS, or similar — out of this package.
- The device never receives `serviceClientId` / secret.
- Wire shape for the lab proxy: `Authorization: Bearer <deviceToken>` + `X-Device-Id: <deviceId>`.

## Hop 2 — SDK edge → OpenBot

Edge holds service secrets (env / secret store) and attaches:

1. `Authorization: Basic <serviceClientId / secret>`
2. `X-OpenBot-Grant-Credential: <grant exchange credential>`
3. `X-Device-Id: <external device id>` — **must equal** `grant.deviceId`

Same three headers as claw4 upload / live-stub. See [docs/integration/claw4-gateway-upload.md](integration/claw4-gateway-upload.md) and [docs/live-stub.md](live-stub.md).

## 可跑实现（P1-3）

| 件 | 路径 |
|---|---|
| 类型 + `LabDeviceEdgeAuthProxy` | `adapters/voice/src/device-edge-auth.ts` |
| loopback HTTP proxy | `services/src/device-edge-auth-proxy.ts` |
| CLI | `npm run device-edge-auth` |

行为：

1. `verifyDevice` 失败 → **HTTP 401**，**不**接触 OpenBot / upstream。
2. 成功 → `buildOpenBotServiceHeaders` 后转发（或内嵌 mock upstream 记录三头）。
3. 设备响应里**不会**回显 service Basic（mock 只回 presence 标志）。

### 本地冒烟（默认内嵌 mock，不必起 :8787）

```bash
npm run device-edge-auth -- --smoke
```

常驻代理：

```bash
# 可选：OPENBOT_DEVICE_EDGE_LAB_TOKENS=dev-edge-lab:ctok_edge_lab
npm run device-edge-auth -- --listen 127.0.0.1:8792
curl -sS -H 'Authorization: Bearer ctok_edge_lab' -H 'X-Device-Id: dev-edge-lab' \
  http://127.0.0.1:8792/proxy/ping
```

接真 stub（须 loopback，可配置）：

```bash
OPENBOT_DEVICE_EDGE_UPSTREAM_URL=http://127.0.0.1:8787 \
OPENBOT_STUB_SERVICE_USER=... \
OPENBOT_STUB_SERVICE_PASSWORD=... \
OPENBOT_STUB_GRANT_CREDENTIAL=... \
OPENBOT_DEVICE_EDGE_LAB_TOKENS=dev-1:ctok_from_claim \
npm run device-edge-auth
```

口令从 openbot-vp 合约针 `d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f` 的 staging.md 抄进环境，**不写进本仓库**。未设 service 环境变量时，冒烟使用 `lab-edge-svc` **占位**（非平台口令，仅 lab）。

也可用 ControlPlane：`createAssessingDeviceVerifier((id, tok) => plane.assessConnectionCredential(id, tok).ok)` —— **不**改 ControlPlane，**不** mint grants。

## Anti-patterns

| Bad | Why |
|---|---|
| Bake service Basic into firmware | Leaks platform secret; cannot rotate per env |
| Send only device token to OpenBot | Integrations expect service Basic + grant |
| Skip `X-Device-Id` | Stub returns `BINDING_MISMATCH` when ≠ grant.deviceId |
| Forward to OpenBot before `verifyDevice` | Leaks edge traffic; bad tokens must 401 locally |

## 非目标

- **不** mint grants；**不**改 ControlPlane / device-control OpenAPI / CONTROL freeze
- **不** PROMOTE；不动 cam_b
- 本片不做 npm 发布、voice harness 扩层、真机 device 层强制 PASS
