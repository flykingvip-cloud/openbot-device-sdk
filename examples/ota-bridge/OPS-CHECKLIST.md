# Ops checklist — device OTA URL → lab bridge → OpenBot voice

## A. Device NVS (配网 / 设置页 — do **not** burn service Basic)

1. Put the device into Wi‑Fi AP config (or settings page that edits NVS `wifi`).
2. Set **Custom OTA URL** / `ota_url` to:

   ```text
   http://<bridge-host>:8002/xiaozhi/ota/
   ```

   Examples:
   - Same LAN as Mac: `http://192.168.x.x:8002/xiaozhi/ota/`
   - Simulator / host-only: `http://127.0.0.1:8002/xiaozhi/ota/`

3. Save. Confirm NVS `wifi/ota_url` is non-empty so firmware does **not** fall back to `https://api.tenclass.net/xiaozhi/ota/`.
4. Do **not** embed platform Basic / service passwords in firmware images.

## B. What lane B must supply

| Item | How |
|------|-----|
| Real voice WSS URL | On **ota-config** process: `OPENBOT_LAB_VOICE_WSS_URL=ws://127.0.0.1:<voice-port>/` (or LAN-reachable `ws://` / `wss://`). Default `wss://lab.invalid/voice` is refused by this bridge. |
| Device token | After claim + bind + credentials issue: set bridge env `OPENBOT_DEVICE_TOKEN=<token>` (no whitespace). Bridge v1 does not mint tokens. |
| Device id | `OPENBOT_DEVICE_ID` matching MAC / `Device-Id` header (used to fetch config). |

Bridge does **not** call grants or `/api/integrations/v1`.

## C. Start stack (lab)

```bash
# 1) ota-config (loopback) — with real voice URL
OPENBOT_LAB_VOICE_WSS_URL='ws://127.0.0.1:8792/' \
  npm run ota-config -- --listen 127.0.0.1:8790 --state var/ota-config.sqlite

# 2) this bridge (reachable from device)
cd examples/ota-bridge
BRIDGE_PORT=8002 \
OPENBOT_OTA_CONFIG_URL=http://127.0.0.1:8790 \
OPENBOT_DEVICE_ID='<mac>' \
OPENBOT_DEVICE_TOKEN='<token>' \
  node server.mjs
```

## D. Curl self-test

```bash
# health
curl -sS http://127.0.0.1:8002/healthz
# → ok

# OTA shape (with lab override if ota-config is down)
OPENBOT_VOICE_WSS_URL='ws://127.0.0.1:8792/' \
OPENBOT_DEVICE_TOKEN='lab-smoke-token' \
OPENBOT_DEVICE_ID='aa:bb:cc:dd:ee:ff' \
  node server.mjs &

curl -sS -X POST http://127.0.0.1:8002/xiaozhi/ota/ \
  -H 'Device-Id: aa:bb:cc:dd:ee:ff' \
  -H 'Content-Type: application/json' \
  -d '{}'
# Expect JSON with websocket.url / websocket.token / websocket.version=1
# and server_time; MUST NOT contain "firmware"
```

Assert:

```bash
curl -sS -X POST http://127.0.0.1:8002/xiaozhi/ota/ \
  -H 'Device-Id: aa:bb:cc:dd:ee:ff' -d '{}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d); if(j.firmware!=null) process.exit(2); if(!j.websocket?.url||j.websocket.version!==1) process.exit(3); console.log("shape ok", j.websocket.url);})'
```

## E. Boot path (device)

1. Device boots → reads NVS `wifi/ota_url` → POST/GET bridge `/xiaozhi/ota/`.
2. Bridge returns `websocket.{url,token,version:1}` (no firmware).
3. Firmware writes NVS `websocket` and connects WSS with `Authorization` / `Device-Id` / `Protocol-Version`.
4. Lab voice accepts hello (`transport=websocket`, Opus 16 kHz / mono / 60 ms, `features.mcp=true`).

## F. Blockers to watch

- `voiceWssUrl` still `wss://lab.invalid/voice` → bridge 503 until B sets `OPENBOT_LAB_VOICE_WSS_URL` (or temporary `OPENBOT_VOICE_WSS_URL` on bridge).
- Empty / whitespace `OPENBOT_DEVICE_TOKEN` → 503.
- Device still on default tenclass OTA → fix NVS `ota_url` via 配网, not flash.
