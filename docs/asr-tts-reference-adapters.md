# ASR / TTS reference adapters (P1-1)

Optional **FunASR- / EdgeTTS-shaped** HTTP reference implementations on top of
`AsrProvider` / `TtsProvider` / `createAudioBridge`. The SDK core stays vendor-
agnostic: defaults remain mock / placeholder, and **no** FunASR or EdgeTTS
runtime, weights, or host is bundled or hardcoded.

## Modules

| Path | Role |
|---|---|
| `adapters/voice/src/reference/http-asr.ts` | `ReferenceHttpAsrProvider` — POST audio → JSON transcript |
| `adapters/voice/src/reference/http-tts.ts` | `ReferenceHttpTtsProvider` — POST text → WAV/PCM → Opus frames |
| `adapters/voice/src/reference/factory.ts` | Env/config factory → providers / `createAudioBridge` |
| `adapters/voice/src/reference/config.ts` | Env key constants + parsers (URLs required; never defaulted) |

Re-exported from `adapters/voice`, `adapters/metalio`, and `services`.

## Env (all optional; default = mock)

| Variable | Meaning |
|---|---|
| `OPENBOT_ASR_PROVIDER` | `mock` (default) \| `reference-http` (alias `funasr-http`) |
| `OPENBOT_ASR_HTTP_URL` | **Required** when ASR is `reference-http` — your FunASR (or compatible) HTTP endpoint |
| `OPENBOT_ASR_HTTP_MODEL` | Optional `model` query param (path/id you supply) |
| `OPENBOT_ASR_HTTP_TEXT_FIELD` | JSON field for transcript (default `text`) |
| `OPENBOT_ASR_HTTP_HEADERS_JSON` | Extra headers as JSON object string |
| `OPENBOT_TTS_PROVIDER` | `mock` (default) \| `reference-http` (alias `edgetts-http`) \| `proportional-silence` \| `opus-frame` |
| `OPENBOT_TTS_HTTP_URL` | **Required** when TTS is `reference-http` — your EdgeTTS (or compatible) HTTP endpoint |
| `OPENBOT_TTS_HTTP_VOICE` | Optional voice id in JSON body |
| `OPENBOT_TTS_HTTP_HEADERS_JSON` | Extra headers as JSON object string |
| `OPENBOT_TTS_SAMPLE_RATE` | Bridge default TTS sample rate (else metalio hello 24000) |
| `OPENBOT_DEVICE_SDK_ROOT` | Checkout path Agent B / gateway uses to resolve this SDK |

**Product 播报:** do **not** set `OPENBOT_TTS_PROVIDER=opus-frame`.
`OpusFrameTtsProvider` ignores text (lab/format only). `createAudioBridgeFromVoiceEnv`
rejects `opus-frame` by default; use `reference-http` or inject a real spoken `TtsProvider`.

## Inject into OpenBot gateway (Agent B)

1. Point the gateway at this checkout:
   ```bash
   export OPENBOT_DEVICE_SDK_ROOT="/Users/daniel/AI VP/openbot-device-sdk"
   ```
2. Bind the audio bridge only when intended (Agent B switch), e.g.:
   ```bash
   export OPENBOT_CLAW4_BIND_DEVICE_SDK_AUDIO_BRIDGE=1
   ```
3. In gateway code, import from the SDK root (path style may vary by B loader):
   ```ts
   import {
     createAudioBridgeFromVoiceEnv,
     createAudioBridge,
     createReferenceHttpAsrProvider,
     createReferenceHttpTtsProvider,
   } from `${process.env.OPENBOT_DEVICE_SDK_ROOT}/adapters/voice/src/index.ts`;

   // Option A — env factory (default mock until URLs + kinds are set):
   const bridge = createAudioBridgeFromVoiceEnv();

   // Option B — explicit inject (recommended for production wiring):
   const bridge = createAudioBridge({
     asr: createReferenceHttpAsrProvider({
       url: process.env.OPENBOT_ASR_HTTP_URL!, // your FunASR wrapper
       model: process.env.OPENBOT_ASR_HTTP_MODEL,
     }),
     tts: createReferenceHttpTtsProvider({
       url: process.env.OPENBOT_TTS_HTTP_URL!, // your EdgeTTS wrapper
       voice: process.env.OPENBOT_TTS_HTTP_VOICE,
     }),
   });
   ```

Reference HTTP shapes (for local wrappers you run yourself):

- **ASR:** `POST` body = WAV or PCM bytes; query may include `model`, `sampleRate`, `channels`, `format`; response JSON `{ "text": "…" }` (field configurable).
- **TTS:** `POST` JSON `{ "text", "sampleRate", "voice?" }`; response = mono 16-bit WAV **or** raw s16le PCM at the requested sample rate; SDK encodes 60 ms Opus frames.

## Uplink stream (P1-2)

`ReferenceHttpAsrProvider.stream()` decodes `codec:"opus"` packets to PCM (boundaries preserved), accumulates, then POSTs via `transcribe`. For true streaming partials / codec-aware FunASR, inject your own Provider (do not wrap with `wrapAsrProviderWithOpusDecode` if it already consumes Opus).

## Out of scope (later slices)

- Edge auth proxy runnable path
- Full voice harness / npm publish / firmware clear-queue

## Related

- [audio-bridge.md](audio-bridge.md)
- [a2-metalio-voice.md](a2-metalio-voice.md)
- [lab-voice.md](lab-voice.md)
