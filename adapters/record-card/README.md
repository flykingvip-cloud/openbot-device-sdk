# Record-card adapter (placeholder)

Plan **A5** reserves this folder for a future recording-card / high-bitrate capture adapter.

| Item | Status |
|---|---|
| Capability matrix profile | `record-card-generic` in `sdk/src/device-capabilities.ts` |
| Opus role | **recording-storage** (often Ogg / high bitrate) |
| Wire / capture / upload | **Not implemented** in A5 |
| device-control v1 OpenAPI | **Must not** gain BLE/USB/mic/storage/speaker routes from this adapter |

## Two Opus roles (do not mix)

| Role | Owner | Shape |
|---|---|---|
| **broadcast-frame** | `adapters/metalio` | Real-time TTS / voice WS bare Opus packets (hello defaults 24 kHz / mono / 60 ms downlink) |
| **recording-storage** | this adapter (later) | High-bitrate capture for upload / archive — **not** metalio hello constants |

See [docs/a5-device-capability-matrix.md](../../docs/a5-device-capability-matrix.md) and [docs/a2-metalio-voice.md](../../docs/a2-metalio-voice.md).

## Out of scope here

- Full record-card implementation
- Gateway `POST /api/v1/upload` / `record/upload` (OpenBot gateway / Agent B)
- Connecting `api.tenclass.net`
- Changing frozen `/api/device-platform/v1`
