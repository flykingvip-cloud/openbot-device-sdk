/**
 * Contract pin for Agent A.
 *
 * `d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f` is the squash merge of
 * https://github.com/flykingvip-cloud/openbot-vp/pull/17 on `main`
 * (B5 gateway mount / recovery / grant→integrations stub registry / joint harness).
 * Frozen field names and the `/api/integrations/v1` prefix are unchanged.
 * Pairing and control-plane fields do not enter the integrations surface.
 * The vendored OpenAPI bytes stay the PR #11 document because that surface
 * did not change; consumer paths and SSE event enums still match, so
 * `routesAligned` is true. That flag is static OpenAPI alignment, not an
 * end-to-end OpenBot pass.
 *
 * The OpenAPI document used for alignment is vendored at
 * `contracts/openbot/device-digital-human.openapi.yaml`.
 * B0 and B2–B5 stand-in handlers are still local and do not serve that HTTP API.
 * `npm run live-stub` can call a loopback stub when OPENBOT_DEVICE_DH_STUB_URL is set.
 *
 * Invalidated and must not be used as the pin:
 * - `490a69669c0cf9e68173ceb25cfa89c99438dfb9` (PR #16 squash; immediate predecessor)
 * - `feeac51863d6d88ba83c7e16029b2911209bb0d0` (PR #15 squash)
 * - `fe1e2c2a81fd3814e8588a854695640ca56db64b` (PR #14 squash)
 * - `92826116a9b00a596ae2360d8a643d6148050e3c` (PR #12 squash)
 * - `d22db4755311a1a0df9fb5e3d5da60554f8ef6a5` (PR #11 squash)
 * - `bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a` (PR #10 squash)
 * - `41b7561222775e4ad00b056e2a535c7f950bcbe9` (PR #9 squash)
 * - `536a963b119f0a00675516401c52dd0f6187b196` (PR #8 squash)
 * - `8abdc7f9a0ae49c340de712fbba235b1064f6c7d` (PR #7 squash)
 * - `554910d835f3baadb1d753532ad510b1b477be09` (pre-merge tip of PR #7)
 * - `dd6c85cae086d90c519ff1be7ad08e20d4644bba` (older parentless snapshot)
 *
 * The short pin `68e062e` on `upbeyond/openbot` is obsolete and must not be read.
 */
export const OPENBOT_CONTRACT_SHA = "d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f";

export const OPENBOT_CONTRACT_REPO = "https://github.com/flykingvip-cloud/openbot-vp";

export const OPENBOT_CONTRACT_PR = "https://github.com/flykingvip-cloud/openbot-vp/pull/17";

/** Immediate predecessor. Invalidated: PR #16 squash, replaced by PR #17. */
export const PR16_SQUASH_CONTRACT_SHA = "490a69669c0cf9e68173ceb25cfa89c99438dfb9";

export const PREVIOUS_CONTRACT_SHA = PR16_SQUASH_CONTRACT_SHA;

/** PR #15 squash. Also invalidated. */
export const PR15_SQUASH_CONTRACT_SHA = "feeac51863d6d88ba83c7e16029b2911209bb0d0";

/** PR #14 squash. Also invalidated. */
export const PR14_SQUASH_CONTRACT_SHA = "fe1e2c2a81fd3814e8588a854695640ca56db64b";

/** PR #12 squash. Also invalidated. */
export const PR12_SQUASH_CONTRACT_SHA = "92826116a9b00a596ae2360d8a643d6148050e3c";

/** PR #11 squash. Also invalidated. */
export const PR11_SQUASH_CONTRACT_SHA = "d22db4755311a1a0df9fb5e3d5da60554f8ef6a5";

/** PR #10 squash. Also invalidated. */
export const PR10_SQUASH_CONTRACT_SHA = "bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a";

/** PR #9 squash. Also invalidated. */
export const PR9_SQUASH_CONTRACT_SHA = "41b7561222775e4ad00b056e2a535c7f950bcbe9";

/** PR #8 squash. Also invalidated. */
export const PR8_SQUASH_CONTRACT_SHA = "536a963b119f0a00675516401c52dd0f6187b196";

/** PR #7 squash. Also invalidated. */
export const PR7_SQUASH_CONTRACT_SHA = "8abdc7f9a0ae49c340de712fbba235b1064f6c7d";

/** Pre-merge tip of PR #7. Also invalidated. */
export const PR7_PREMERGE_CONTRACT_SHA = "554910d835f3baadb1d753532ad510b1b477be09";

/** Older parentless snapshot. Also invalidated. */
export const OLDER_CONTRACT_SHA = "dd6c85cae086d90c519ff1be7ad08e20d4644bba";

export const INVALIDATED_CONTRACT_SHAS = [
  PREVIOUS_CONTRACT_SHA,
  PR15_SQUASH_CONTRACT_SHA,
  PR14_SQUASH_CONTRACT_SHA,
  PR12_SQUASH_CONTRACT_SHA,
  PR11_SQUASH_CONTRACT_SHA,
  PR10_SQUASH_CONTRACT_SHA,
  PR9_SQUASH_CONTRACT_SHA,
  PR8_SQUASH_CONTRACT_SHA,
  PR7_SQUASH_CONTRACT_SHA,
  PR7_PREMERGE_CONTRACT_SHA,
  OLDER_CONTRACT_SHA,
] as const;

export const OBSOLETE_CONTRACT_SHA_PREFIX = "68e062e";

export const OBSOLETE_CONTRACT_REPO = "https://github.com/upbeyond/openbot";

export const LIVE_STUB_ENV = "OPENBOT_DEVICE_DH_STUB_URL";

export const CONTRACT_PIN = {
  sha: OPENBOT_CONTRACT_SHA,
  repo: OPENBOT_CONTRACT_REPO,
  pr: OPENBOT_CONTRACT_PR,
  status: "main",
  merge: "squash",
  officialMergeSha: OPENBOT_CONTRACT_SHA,
  previousSha: PREVIOUS_CONTRACT_SHA,
  previousShaStatus: "invalidated",
  invalidatedShas: INVALIDATED_CONTRACT_SHAS,
  deviceApiRange: "B0-B5",
  deviceApisPresent: "reported-stub",
  routesAligned: true,
  access: "vendored",
  routeSource: "vendored-openapi",
  liveStubEnv: LIVE_STUB_ENV,
  obsolete: {
    shaPrefix: OBSOLETE_CONTRACT_SHA_PREFIX,
    repo: OBSOLETE_CONTRACT_REPO,
  },
} as const;
