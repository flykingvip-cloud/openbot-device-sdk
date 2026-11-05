# Lab Xiaozhi OTA → OpenBot voice WSS bridge

Deployment-side lab helper. Metalio/Xiaozhi firmware boots, GETs NVS `wifi/ota_url`, and expects a Xiaozhi-shaped JSON with a `websocket` block. This bridge serves that shape and points `websocket.url` at the OpenBot lab voice WSS from **ota-config** — without changing frozen device-control OpenAPI, `OPENBOT_CONTRACT_SHA`, or core SDK service APIs.

**Not** a firmware flash path. **Never** returns `firmware` / `firmware.url`. Does **not** mint `authorizationRef` / grants. Does **not** proxy `/api/integrations/v1`.

Targets: MetalioClaw4 tip `3d12a6ea` + openbot-device-sdk tip `87a4a1a`.

## Run

```bash
cd examples/ota-bridge

export BRIDGE_PORT=8002
export OPENBOT_OTA_CONFIG_URL=http://127.0.0.1:8790
export OPENBOT_DEVICE_ID='aa:bb:cc:dd:ee:ff'   # MAC / Device-Id
export OPENBOT_DEVICE_TOKEN='<token after claim/bind>'  # non-empty, no whitespace

# Optional lab override when ota-config is down (smoke only):
# export OPENBOT_VOICE_WSS_URL='ws://127.0.0.1:8792/'

node server.mjs
```

Listen: `0.0.0.0:${BRIDGE_PORT}` (default **8002**).

## Endpoints

| Method | Path | Behavior |
|--------|------|----------|
| GET/POST | `/xiaozhi/ota/` and `/xiaozhi/ota` | Drain body; return Xiaozhi OTA JSON (websocket + server_time only) |
| GET | `/healthz` | plain `ok` |

### Response shape (only)

```json
{
  "websocket": { "url": "ws://…", "token": "…", "version": 1 },
  "server_time": { "timestamp": 0, "timezone_offset": 480 }
}
```

- `websocket.url` ← `GET {OPENBOT_OTA_CONFIG_URL}/devices/{DEVICE_ID}/config` → `voiceWssUrl` (cache ~30s). Refuses `wss://lab.invalid/voice`.
- `websocket.token` ← env `OPENBOT_DEVICE_TOKEN` (v1). Optional later: credentials refresh via ota-config `POST …/credentials/refresh` — keep v1 simple with env.
- Logs `Device-Id` header on each OTA hit.

### Lab override

If ota-config is unreachable **and** `OPENBOT_VOICE_WSS_URL` is set, the bridge uses that URL (still refuses `lab.invalid`). Documented for local curl smoke only; production-shaped lab runs should set `OPENBOT_LAB_VOICE_WSS_URL` on the **ota-config** process instead.

## What this is not

- No PROMOTE / cam_b / grayRelease
- No burning platform Basic into firmware
- No changes to CONTRACT SHA or device-control OpenAPI
- Device NVS `ota_url` is set via 配网/设置页 — not by flashing service credentials

See [OPS-CHECKLIST.md](./OPS-CHECKLIST.md) for device NVS, curl self-test, and what B must supply.
