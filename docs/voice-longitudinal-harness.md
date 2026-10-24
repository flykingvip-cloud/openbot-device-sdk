# Longitudinal voice harness (P1-5)

`npm run voice-joint` is **HTTP compat smoke** only (silent WAV + optional `?transcript=` passthrough on stub `:8787`). It is **not** voice E2E.

This document is the longitudinal voice harness checklist and layer status.
Runnable entry for the **sim** layer: `npm run voice-harness` / `npm run voice-harness:sim`
(implementation: `services/src/voice-harness.ts`). Failures on sim exit non-zero.

## Layers

| Layer | Status | Notes |
|---|---|---|
| sim (lab-voice + injected providers / bridge) | **partial** (P1-5) | In-process harness with mock ASR + `ProportionalSilenceTtsProvider`. No FunASR weights. Not `voice-joint`. |
| real (loopback stub + real ASR/TTS weights outside package) | JOINT_PENDING | Needs weights + stub; not this slice |
| device (Metalio board + edge) | JOINT_PENDING | Board evidence; not this slice |

## Layered interface

```ts
import { createVoiceLongitudinalHarness } from "../services/src/voice-harness.ts";

const harness = createVoiceLongitudinalHarness();
await harness.runSim();    // executable — exit ≠ 0 on failure
await harness.runReal();   // JOINT_PENDING report
await harness.runDevice(); // JOINT_PENDING report
```

## Checklist

| # | Item | sim | real | device |
|---|---|---|---|---|
| 1 | Known WAV fixture (not empty / not UTF-8 hint) | **PASS** (`buildKnownWavFixture`) | JOINT_PENDING | JOINT_PENDING |
| 2 | **No** transcript passthrough (`?transcript=` / `X-Transcript-Text` must not substitute for ASR) | **PASS** (harness ignores hostile hints; ASR ≠ passthrough) | JOINT_PENDING | JOINT_PENDING |
| 3 | Expect ASR text from `AsrProvider.transcribe` / bridge `transcribeWav` | **PASS** | JOINT_PENDING | JOINT_PENDING |
| 4 | Wait for assistant reply text (integrations / messages — not `data.text` upload passthrough alone) | **PASS** (mock `assistant.final`) | JOINT_PENDING | JOINT_PENDING |
| 5 | TTS ≠ fixed tone: inject real `TtsProvider` or `ProportionalSilenceTtsProvider`; do not treat `OpusFrameTtsProvider` as spoken TTS | **PASS** (spoken gate + proportional frames) | JOINT_PENDING | JOINT_PENDING |
| 6 | Abort in-flight ASR/TTS via bridge abort handle / metalio abort | **PASS** (bridge abort handle) | JOINT_PENDING | JOINT_PENDING |
| 7 | Revoke grant → subsequent upload/session fails (`AUTH_REVOKED`) | **PASS** (in-process lab stub contract) + **gate** | JOINT_PENDING | JOINT_PENDING |

### Revoke gate (item 7)

This repo does **not** host the OpenBot grant service. Sim proves the **`AUTH_REVOKED` contract shape** with an in-process lab stub (`POST /api/v1/grants/revoke` → later `POST /api/v1/upload` returns HTTP 401 / `error.code=AUTH_REVOKED`).

**Real revoke** against Agent B stub `:8787` remains a documentation gate:

- Set `OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787` plus service Basic + grant credential + device id (see [claw4-gateway-upload.md](integration/claw4-gateway-upload.md)).
- After B-side `revoke`, upload / session must fail with `AUTH_REVOKED`.
- That live proof is **JOINT_PENDING** until exercised jointly; skipping without the stub is not a pass.

## How to run

```bash
npm run voice-harness          # sim (default)
npm run voice-harness:sim      # same
npm run voice-harness -- --help
npm run voice-harness -- --layer real    # JOINT_PENDING report only
npm run voice-harness -- --layer device  # JOINT_PENDING report only
```

Keep `npm run voice-joint` for HTTP compat smoke. Do **not** fold this into `npm run sim`.

## Related

- Bridge contract: [docs/audio-bridge.md](audio-bridge.md)
- HTTP smoke: [docs/integration/claw4-gateway-upload.md](integration/claw4-gateway-upload.md)
- Joint pending vocabulary: [docs/integration/joint-acceptance.md](integration/joint-acceptance.md)
- Lab voice: [docs/lab-voice.md](lab-voice.md)
