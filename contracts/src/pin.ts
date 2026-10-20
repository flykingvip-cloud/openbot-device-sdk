/**
 * Contract pin for Agent A.
 *
 * `flykingvip-cloud/openbot-vp` at this SHA is a parentless recovery snapshot.
 * It does not contain B0–B5 device APIs. Keep the local stand-in document.
 * The short pin `68e062e` on `upbeyond/openbot` is obsolete and must not be read.
 */
export const OPENBOT_CONTRACT_SHA = "dd6c85cae086d90c519ff1be7ad08e20d4644bba";

export const OPENBOT_CONTRACT_REPO = "https://github.com/flykingvip-cloud/openbot-vp";

export const OBSOLETE_CONTRACT_SHA_PREFIX = "68e062e";

export const OBSOLETE_CONTRACT_REPO = "https://github.com/upbeyond/openbot";

export const LIVE_STUB_ENV = "OPENBOT_DEVICE_DH_STUB_URL";

export const CONTRACT_PIN = {
  sha: OPENBOT_CONTRACT_SHA,
  repo: OPENBOT_CONTRACT_REPO,
  snapshot: "parentless-recovery",
  deviceApisPresent: false,
  deviceApiRange: "B0-B5",
  liveStubEnv: LIVE_STUB_ENV,
  obsolete: {
    shaPrefix: OBSOLETE_CONTRACT_SHA_PREFIX,
    repo: OBSOLETE_CONTRACT_REPO,
  },
} as const;
