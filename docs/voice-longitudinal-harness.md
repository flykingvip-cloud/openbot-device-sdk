# Longitudinal voice harness checklist (future)

`npm run voice-joint` is **HTTP compat smoke** only (silent WAV + optional `?transcript=` passthrough on stub `:8787`). It is **not** voice E2E.

This checklist is for a future longitudinal voice harness. Layers still `JOINT_PENDING` until marked otherwise.

## Layers

| Layer | Status |
|---|---|
| sim (lab-voice + injected providers) | JOINT_PENDING |
| real (loopback stub + real ASR/TTS weights outside package) | JOINT_PENDING |
| device (Metalio board + edge) | JOINT_PENDING |

## Checklist

- [ ] Known WAV fixture (not empty / not UTF-8 hint)
- [ ] **No** transcript passthrough (`?transcript=` / `X-Transcript-Text` must not substitute for ASR)
- [ ] Expect ASR text from `AsrProvider.transcribe` / bridge `transcribeWav`
- [ ] Wait for assistant reply text (integrations / messages — not `data.text` upload passthrough alone)
- [ ] TTS ≠ fixed tone: inject real `TtsProvider` or `ProportionalSilenceTtsProvider` (length ∝ text); do not treat `OpusFrameTtsProvider` as spoken TTS
- [ ] Abort in-flight ASR/TTS via bridge abort handle / metalio abort
- [ ] Revoke grant → subsequent upload/session fails (`AUTH_REVOKED`)

## Related

- Bridge contract: [docs/audio-bridge.md](audio-bridge.md)
- HTTP smoke: [docs/integration/claw4-gateway-upload.md](integration/claw4-gateway-upload.md)
- Joint pending vocabulary: [docs/integration/joint-acceptance.md](integration/joint-acceptance.md)
