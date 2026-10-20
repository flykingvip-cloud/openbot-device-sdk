/**
 * Contract pin for Agent A.
 *
 * `554910d835f3baadb1d753532ad510b1b477be09` is the pre-merge tip of
 * https://github.com/flykingvip-cloud/openbot-vp/pull/7. Agent B reported that
 * B0–B5 landed there. This environment cannot read that repository (HTTP 404),
 * so local stand-in routes were not rewritten from the tip.
 * Replace this SHA with the official main merge SHA when Agent B sends it.
 * `dd6c85cae086d90c519ff1be7ad08e20d4644bba` is the previous parentless snapshot.
 * The short pin `68e062e` on `upbeyond/openbot` is obsolete and must not be read.
 */
export const OPENBOT_CONTRACT_SHA = "554910d835f3baadb1d753532ad510b1b477be09";

export const OPENBOT_CONTRACT_REPO = "https://github.com/flykingvip-cloud/openbot-vp";

export const OPENBOT_CONTRACT_PR = "https://github.com/flykingvip-cloud/openbot-vp/pull/7";

export const PREVIOUS_CONTRACT_SHA = "dd6c85cae086d90c519ff1be7ad08e20d4644bba";

export const OBSOLETE_CONTRACT_SHA_PREFIX = "68e062e";

export const OBSOLETE_CONTRACT_REPO = "https://github.com/upbeyond/openbot";

export const LIVE_STUB_ENV = "OPENBOT_DEVICE_DH_STUB_URL";

export const CONTRACT_PIN = {
  sha: OPENBOT_CONTRACT_SHA,
  repo: OPENBOT_CONTRACT_REPO,
  pr: OPENBOT_CONTRACT_PR,
  status: "pre-merge-tip",
  officialMergeSha: null,
  previousSha: PREVIOUS_CONTRACT_SHA,
  deviceApiRange: "B0-B5",
  deviceApisPresent: "unverified",
  routesAligned: false,
  access: "unreadable-404",
  routeSource: "local-mock-access-limited",
  liveStubEnv: LIVE_STUB_ENV,
  obsolete: {
    shaPrefix: OBSOLETE_CONTRACT_SHA_PREFIX,
    repo: OBSOLETE_CONTRACT_REPO,
  },
} as const;
