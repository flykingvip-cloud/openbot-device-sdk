# Audio bridge (Agent A P0)

Injectable contract so claw4 / edge compat (Agent B) can call ASR/TTS without hardcoding vendors.

## API

Module: `adapters/voice` — `createAudioBridge` / `InjectableAudioBridge`.

| Direction | Contract |
|---|---|
| Uplink whole utterance | `wavBytes → AsrProvider.transcribe` via `resolveAsrAudio` — **no** default pass-through transcript |
| Downlink speech | `assistantText → TtsProvider.synthesize → Opus frames` |
| Cancel | `createAbortHandle()` → `AbortSignal` on in-flight ASR/TTS |

Providers stay injectable. This SDK does not ship FunASR / EdgeTTS weights.

## OpusFrameTtsProvider vs spoken TTS

`OpusFrameTtsProvider` is **format / lab only**: it **ignores text** and emits a fixed number of tone/silence Opus frames to prove the metalio downlink is decodable. Do **not** inject it into the bridge for product spoken TTS.

For tests that need the path wired without a vendor, use `ProportionalSilenceTtsProvider`: silence PCM whose **length is proportional to text** (not a fixed tone pretending to be speech), then the existing `OpusFrameEncoder` path.

## Uplink Opus (`AsrStreamChunk`) — P1-2

Optional `codec` / `format`: `"pcm" | "wav" | "opus"` (omit = pcm, backward compatible).

- Lab must **not** label Opus uplink as PCM.
- Packet boundaries must be preserved (one WS binary frame ≈ one Opus packet).
- **Mock / reference** `stream()` decode Opus → PCM via libopus (`createOpusUplinkDecoder`), then run existing PCM ASR rules.
- **Codec-aware Provider:** inject a Provider that reads `codec: "opus"` directly. Do **not** wrap it with `wrapAsrProviderWithOpusDecode` (that helper is only for PCM-only Providers).
- Lab `finishUtterance` calls `asrProvider.stream()` for packetized uplink (WAV whole-file still uses `transcribe`).

## Related

- Providers: [docs/a2-metalio-voice.md](a2-metalio-voice.md), [docs/lab-voice.md](lab-voice.md)
- Device→edge auth: [docs/device-edge-auth.md](device-edge-auth.md)
- Future voice E2E checklist: [docs/voice-longitudinal-harness.md](voice-longitudinal-harness.md)
- HTTP compat smoke (not voice E2E): `npm run voice-joint` — [docs/integration/claw4-gateway-upload.md](integration/claw4-gateway-upload.md)

## Reference ASR/TTS inject (P1-1)

Optional FunASR-/EdgeTTS-shaped HTTP adapters + env factory:
[docs/asr-tts-reference-adapters.md](asr-tts-reference-adapters.md).

```ts
import { createAudioBridgeFromVoiceEnv } from "../adapters/voice/src/index.ts";
// Default mock. Set OPENBOT_ASR_PROVIDER=reference-http + OPENBOT_ASR_HTTP_URL
// (and TTS equivalents) to opt into HTTP reference providers — no vendor host hardcoded.
const bridge = createAudioBridgeFromVoiceEnv();
```

Agent B: set `OPENBOT_DEVICE_SDK_ROOT` to this checkout, then import `createAudioBridge` /
`createAudioBridgeFromVoiceEnv`. Product spoken TTS must **not** use `OpusFrameTtsProvider`.
