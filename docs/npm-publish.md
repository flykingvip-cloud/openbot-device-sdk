# npm publish prep (P1-6)

Private package for Agent B / gateway to install the **voice adapter** surface
(`createAudioBridge`, providers, reference/env factory) from GitHub Packages
instead of only pinning a git checkout via `OPENBOT_DEVICE_SDK_ROOT`.

| Item | Value |
|---|---|
| Package | `@flykingvip-cloud/openbot-device-sdk` |
| Version | `0.1.0` (first publishable prep; was `0.0.0` + `private: true`) |
| Registry | GitHub Packages `https://npm.pkg.github.com` |
| Publish shape | **(A) compiled `dist/`** — ESM + `.d.ts` (voice + metalio Opus helpers) |
| Contract pin | `OPENBOT_CONTRACT_SHA=d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f` |

**This repo does not run a real `npm publish` in CI or by default.** Maintainers
publish only after an explicit token + go-ahead. Use `npm run pack:check` and
`npm run publish:dry-run` locally.

## What is in the package

Published `files`:

- `dist/` — `dist/voice/**` (bridge, providers, reference, device-edge-auth) and
  the minimal `dist/metalio/**` Opus helpers voice needs (`constants`,
  `opus-boundary`, `opus-encoder`)
- `docs/npm-publish.md`, `README.md`, `LICENSE`

**Not** published: CONTROL freeze, device-control OpenAPI, console/sim CLIs,
firmware paths, or any service Basic credentials.

Local monorepo development is unchanged: Node strip-types on `.ts` sources,
`npm test` / `npm run typecheck`.

## Maintainer: pack / dry-run (no real publish)

```bash
npm install
npm run typecheck
npm test
npm run build:publish          # → dist/
npm run pack:check             # pack + extract + import smoke
npm run publish:dry-run        # npm publish --dry-run (no upload)
```

`prepack` runs `build:publish`, so plain `npm pack` also rebuilds `dist/`.

## Maintainer: real publish (manual, gated)

1. Repo **Packages** write permission for the publishing identity.
2. A token with `write:packages` (and `read:packages`), e.g. classic PAT or
   fine-grained with Packages write on `flykingvip-cloud/openbot-device-sdk`.
3. Project or user `.npmrc` (do **not** commit tokens):

   ```ini
   @flykingvip-cloud:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

4. Then, only when explicitly approved:

   ```bash
   export GITHUB_TOKEN=…   # packages:write
   npm publish
   ```

`publishConfig.registry` points at GitHub Packages; `access` is `restricted`
(private package). Do **not** publish this scope to the public npm registry.

## Agent B / gateway: install from package

`.npmrc` (consumer):

```ini
@flykingvip-cloud:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs `read:packages` (and SSO / org access if required).

```bash
npm install @flykingvip-cloud/openbot-device-sdk@0.1.0
```

```ts
import {
  createAudioBridgeFromVoiceEnv,
  createAudioBridge,
  createReferenceHttpAsrProvider,
  createReferenceHttpTtsProvider,
} from "@flykingvip-cloud/openbot-device-sdk";
// or: from "@flykingvip-cloud/openbot-device-sdk/voice"

const bridge = createAudioBridgeFromVoiceEnv();
```

### Compatibility: `OPENBOT_DEVICE_SDK_ROOT` override

Checkout pin remains supported for full-tree / unreleased tip work:

```bash
export OPENBOT_DEVICE_SDK_ROOT="/path/to/openbot-device-sdk"
```

```ts
import { createAudioBridgeFromVoiceEnv } from `${process.env.OPENBOT_DEVICE_SDK_ROOT}/adapters/voice/src/index.ts`;
```

**Recommended for product gateway:** prefer the npm package import. Use
`OPENBOT_DEVICE_SDK_ROOT` only as an override (local tip, debugging, or modules
not yet in `dist/`).

Env keys for reference ASR/TTS (`OPENBOT_ASR_*`, `OPENBOT_TTS_*`, bind switch,
etc.) are unchanged — see [asr-tts-reference-adapters.md](asr-tts-reference-adapters.md).

## Changelog (npm surface)

### 0.1.0

- First publishable layout: scoped name, GitHub Packages `publishConfig`,
  compiled `dist/` voice (+ metalio Opus subset) exports.
- Docs for `.npmrc`, pack/dry-run, and Agent B install vs ROOT override.
- **No** real publish performed in the prep PR.
