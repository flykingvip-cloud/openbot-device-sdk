#!/usr/bin/env bash
# Claw4 gateway upload smoke against OpenBot stub :8787 (Scheme B1 / SDK A6).
# Does NOT call device-control or npm run sim. Credentials from env only — never commit secrets.
set -euo pipefail

STUB_URL="${OPENBOT_DEVICE_DH_STUB_URL:-http://127.0.0.1:8787}"
TRANSCRIPT="${OPENBOT_VOICE_JOINT_TRANSCRIPT:-claw4-upload-smoke}"
DEVICE_ID="${OPENBOT_STUB_DEVICE_ID:-}"
SERVICE_USER="${OPENBOT_STUB_SERVICE_USER:-}"
SERVICE_PASSWORD="${OPENBOT_STUB_SERVICE_PASSWORD:-}"
GRANT="${OPENBOT_STUB_GRANT_CREDENTIAL:-}"

if [[ -z "$SERVICE_USER" || -z "$SERVICE_PASSWORD" || -z "$GRANT" || -z "$DEVICE_ID" ]]; then
  cat <<'HELP'
用法（主路径 stub :8787）:
  OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787 \
  OPENBOT_STUB_SERVICE_USER=... \
  OPENBOT_STUB_SERVICE_PASSWORD=... \
  OPENBOT_STUB_GRANT_CREDENTIAL=... \
  OPENBOT_STUB_DEVICE_ID=... \
  ./examples/claw4-upload-curl.sh

口令从 openbot-vp docs/integrations/device-digital-human/staging.md 抄。
权威路由说明：openbot-vp docs/integrations/device-digital-human/claw4-firmware-http-compat.md
gateway :18789 未注入 DeviceDhService 时对 /api/v1/* 为 503 — 请用 stub 8787。
data.text = ASR/透传文本，不是 assistant.final。
不进 npm run sim；联合姿势见 docs/integration/claw4-gateway-upload.md。
HELP
  exit 0
fi

WAV="$(mktemp -t claw4-upload.XXXXXX.wav)"
cleanup() { rm -f "$WAV"; }
trap cleanup EXIT

python3 - "$WAV" <<'PY'
import struct, sys
path = sys.argv[1]
sr, ch, bps, n = 16000, 1, 16, 320
data = b"\x00\x00" * n
byte_rate = sr * ch * bps // 8
block = ch * bps // 8
header = struct.pack(
    "<4sI4s4sIHHIIHH4sI",
    b"RIFF", 36 + len(data), b"WAVE", b"fmt ", 16,
    1, ch, sr, byte_rate, block, bps, b"data", len(data),
)
open(path, "wb").write(header + data)
PY

ENC_TRANSCRIPT="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$TRANSCRIPT")"
UPLOAD_URL="${STUB_URL%/}/api/v1/upload?transcript=${ENC_TRANSCRIPT}"

echo "POST $UPLOAD_URL"
UPLOAD_JSON="$(curl -sS -u "${SERVICE_USER}:${SERVICE_PASSWORD}" \
  -H "X-OpenBot-Grant-Credential: ${GRANT}" \
  -H "X-Device-Id: ${DEVICE_ID}" \
  -H "Content-Type: audio/wav" \
  --data-binary @"${WAV}" \
  "$UPLOAD_URL")"
echo "$UPLOAD_JSON"

CONV_ID="$(TRANSCRIPT="$TRANSCRIPT" UPLOAD_JSON="$UPLOAD_JSON" python3 <<'PY'
import json, os, sys
j = json.loads(os.environ["UPLOAD_JSON"])
assert j.get("code") == 0, j
data = j.get("data") or {}
expect = os.environ["TRANSCRIPT"]
assert data.get("text") == expect, (data.get("text"), expect)
cid = data.get("conversationId")
assert cid, data
print(cid)
PY
)"

MSG_URL="${STUB_URL%/}/api/v1/conversation/${CONV_ID}/messages"
echo "GET $MSG_URL"
curl -sS -u "${SERVICE_USER}:${SERVICE_PASSWORD}" \
  -H "X-OpenBot-Grant-Credential: ${GRANT}" \
  -H "X-Device-Id: ${DEVICE_ID}" \
  "$MSG_URL"
echo
echo "ok: upload+messages on stub (data.text=ASR/passthrough). JOINT_PENDING: UI staging real-device production"
