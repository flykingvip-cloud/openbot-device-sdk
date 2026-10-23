# Device → edge → OpenBot auth (sketch)

Two-hop. **Firmware must not burn platform / integrations service Basic.**

```
device  --(per-device creds)-->  SDK edge  --(service Basic + grant + X-Device-Id)-->  OpenBot
```

## Hop 1 — device → SDK edge

- Lab today: claim / redeem → short-lived **connection token** from the local control plane (`issueConnectionCredentialWithProof`, OTA config credentials HTTP). See [docs/a4-claim-bind-ota.md](a4-claim-bind-ota.md).
- Product later: device identity, mTLS, or similar — out of this package.
- The device never receives `serviceClientId:secret`.

## Hop 2 — SDK edge → OpenBot

Edge holds service secrets (env / secret store) and attaches:

1. `Authorization: Basic <serviceClientId:secret>`
2. `X-OpenBot-Grant-Credential: <grant exchange credential>`
3. `X-Device-Id: <external device id>` — **must equal** `grant.deviceId`

Same three headers as claw4 upload / live-stub. See [docs/integration/claw4-gateway-upload.md](integration/claw4-gateway-upload.md) and [docs/live-stub.md](live-stub.md).

## Minimal types

`adapters/voice/src/device-edge-auth.ts`:

- `DeviceEdgeDeviceCredential` / `DeviceEdgeServiceCredential`
- `buildOpenBotServiceHeaders(service, deviceId)`
- optional `DeviceEdgeAuthProxy` interface (verify device hop, then forward)

**Does not** mint grants, **does not** change control plane or device-control OpenAPI. A full loopback proxy is P1 if needed.

## Anti-patterns

| Bad | Why |
|---|---|
| Bake service Basic into firmware | Leaks platform secret; cannot rotate per env |
| Send only device token to OpenBot | Integrations expect service Basic + grant |
| Skip `X-Device-Id` | Stub returns `BINDING_MISMATCH` when ≠ grant.deviceId |
