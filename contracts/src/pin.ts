/**
 * Contract pin for Agent A.
 *
 * `41b7561222775e4ad00b056e2a535c7f950bcbe9` is the squash merge of
 * https://github.com/flykingvip-cloud/openbot-vp/pull/9 on `main`.
 * Frozen field names and the `/api/integrations/v1` prefix are unchanged.
 *
 * The OpenAPI document from that commit is vendored at
 * `contracts/openbot/device-digital-human.openapi.yaml`.
 * Consumer paths and SSE event enums match those bytes, so `routesAligned` is true.
 * B0 and B2–B5 stand-in handlers are still local and do not serve that HTTP API.
 *
 * Invalidated and must not be used as the pin:
 * - `536a963b119f0a00675516401c52dd0f6187b196` (PR #8 squash; immediate predecessor)
 * - `8abdc7f9a0ae49c340de712fbba235b1064f6c7d` (PR #7 squash)
 * - `554910d835f3baadb1d753532ad510b1b477be09` (pre-merge tip of PR #7)
 * - `dd6c85cae086d90c519ff1be7ad08e20d4644bba` (older parentless snapshot)
 *
 * The short pin `68e062e` on `upbeyond/openbot` is obsolete and must not be read.
 */
export const OPENBOT_CONTRACT_SHA = "41b7561222775e4ad00b056e2a535c7f950bcbe9";

export const OPENBOT_CONTRACT_REPO = "https://github.com/flykingvip-cloud/openbot-vp";

export const OPENBOT_CONTRACT_PR = "https://github.com/flykingvip-cloud/openbot-vp/pull/9";

/** Immediate predecessor. Invalidated: PR #8 squash, replaced by PR #9. */
export const PREVIOUS_CONTRACT_SHA = "536a963b119f0a00675516401c52dd0f6187b196";

/** PR #7 squash. Also invalidated. */
export const PR7_SQUASH_CONTRACT_SHA = "8abdc7f9a0ae49c340de712fbba235b1064f6c7d";

/** Pre-merge tip of PR #7. Also invalidated. */
export const PR7_PREMERGE_CONTRACT_SHA = "554910d835f3baadb1d753532ad510b1b477be09";

/** Older parentless snapshot. Also invalidated. */
export const OLDER_CONTRACT_SHA = "dd6c85cae086d90c519ff1be7ad08e20d4644bba";

export const INVALIDATED_CONTRACT_SHAS = [
  PREVIOUS_CONTRACT_SHA,
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
