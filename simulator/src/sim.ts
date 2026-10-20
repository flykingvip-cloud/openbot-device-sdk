import { rmSync } from "node:fs";

import { OPENBOT_CONTRACT_SHA, assistantEqual, type AssistantFields } from "../../contracts/src/index.ts";
import { readDigitalHuman } from "../../integrations/openbot-b1/src/index.ts";
import {
  SESSION_CURSOR_TTL_MS,
  SessionBook,
  SessionError,
} from "../../integrations/openbot-b2/src/index.ts";
import { speakVisibleAssistant } from "../../integrations/openbot-b3/src/index.ts";
import { ControlPlane, ControlPlaneError, openStaging, type StagingDb } from "../../services/src/index.ts";

const PINNED_SHA = "bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a";
const DEVICE_ID = "dev-sim";
const DIGITAL_HUMAN_ID = "dh-sim";
const SECRET = "do-not-speak-secret";
const VISIBLE = "visible-speech-only";

const ASSISTANT: AssistantFields = {
  voiceId: "voice-lab",
  systemPrompt: SECRET,
  visible: { speech: VISIBLE, note: SECRET },
};

export interface SimulatorReport {
  lines: string[];
  contractSha: string;
  b1Idempotent: boolean;
  assistantPreserved: boolean;
  sessionId: string;
  idempotentSession: boolean;
  sessionBusy: boolean;
  duplicateEventIgnored: boolean;
  duplicateSurvivedRestart: boolean;
  cursorExpired: boolean;
  visibleTtsText: string;
  visibleTtsExcludesSecret: boolean;
  refreshRotated: boolean;
  oldTokenRejected: boolean;
  lateCameraCode: string;
  flashCode: string;
  massFlashCode: string;
  otaFirmwareUrl: null;
  otaExecutable: false;
  reloadedRevoked: boolean;
  reloadedLateCameraCode: string;
  reloadedCursorExpired: boolean;
  reloadedSessionClosed: boolean;
}

export async function runSimulator(statePath: string): Promise<SimulatorReport> {
  assertPinnedSha();
  resetState(statePath);
  const lines: string[] = [];
  let now = 1_700_000_000_000;
  const clock = () => now;
  let refs = 0;
  let tokens = 0;
  const generators = {
    now: clock,
    code: () => "100001",
    authorizationRef: () => {
      refs += 1;
      return `aref_sim_${refs}`;
    },
    token: () => {
      tokens += 1;
      return `ctok_sim_${tokens}`;
    },
  };

  say(lines, "设备模拟器（无真机、无网络、无烧录）");
  say(lines, `状态: ${statePath}`);
  say(lines, `合约针: ${OPENBOT_CONTRACT_SHA}`);
  say(lines, "正式针: openbot-vp main，PR #10 的 squash merge。已作废: 41b7561222775e4ad00b056e2a535c7f950bcbe9、536a963b119f0a00675516401c52dd0f6187b196、8abdc7f9a0ae49c340de712fbba235b1064f6c7d、554910d835f3baadb1d753532ad510b1b477be09 与更早的 dd6c85cae086d90c519ff1be7ad08e20d4644bba。");
  say(lines, "OpenAPI 已按 bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a 入库（更早的树拉取曾返回 404）。routesAligned 为 true，只表示静态 OpenAPI 对齐，不是端到端联调。B2–B5 仍用本地 stand-in。");

  let sessionId = "";
  let b1Idempotent = false;
  let assistantPreserved = false;
  let idempotentSession = false;
  let sessionBusy = false;
  let duplicateEventIgnored = false;
  let visibleTtsText = "";
  let visibleTtsExcludesSecret = false;

  await withDb(statePath, (db) => {
    const plane = new ControlPlane({ store: db, ...generators });
    const book = new SessionBook({ plane, store: db, now: clock, sessionId: () => "sess_sim" });
    plane.redeemClaim(DEVICE_ID, plane.issueClaim(DEVICE_ID).code);
    const binding = plane.bind({
      deviceId: DEVICE_ID,
      digitalHumanId: DIGITAL_HUMAN_ID,
      assistant: ASSISTANT,
    });
    assistantPreserved = assistantEqual(binding.assistant, ASSISTANT);
    say(lines, `认领并绑定 ${DEVICE_ID} bindingVersion=${binding.bindingVersion}`);

    return { binding, book, plane };
  });

  await withDb(statePath, async (db) => {
    const plane = new ControlPlane({ store: db, ...generators, now: clock });
    const once = await readDigitalHuman(DIGITAL_HUMAN_ID, { plane, idempotencyKey: "sim-b1" });
    const twice = await readDigitalHuman(DIGITAL_HUMAN_ID, { plane, idempotencyKey: "sim-b1" });
    b1Idempotent =
      JSON.stringify(once.assistant) === JSON.stringify(twice.assistant) &&
      once.assistant.systemPrompt === SECRET &&
      twice.assistant.systemPrompt === SECRET;
    const book = new SessionBook({ plane, store: db, now: clock, sessionId: () => "sess_sim" });
    const binding = plane.getBinding(DEVICE_ID);
    if (!binding) {
      throw new Error("simulator lost the binding");
    }
    const request = {
      authorizationRef: binding.authorizationRef,
      bindingVersion: binding.bindingVersion,
      digitalHumanId: binding.digitalHumanId,
      deviceId: binding.deviceId,
      idempotencyKey: "sim-open",
    };
    const opened = book.open(request);
    const replay = book.open(request);
    sessionId = opened.sessionId;
    idempotentSession = opened.sessionId === replay.sessionId;
    try {
      book.open({ ...request, idempotencyKey: "sim-other" });
    } catch (error) {
      sessionBusy = error instanceof SessionError && error.code === "SESSION_BUSY";
    }
    const appended = book.append(sessionId, { eventId: "evt-sim-1", type: "device.heartbeat" });
    const duplicate = book.append(sessionId, { eventId: "evt-sim-1", type: "device.heartbeat" });
    const pulled = book.pull(sessionId, 0);
    duplicateEventIgnored = appended.accepted && duplicate.duplicate && !duplicate.accepted && pulled.events.length === 1;
    const tts = speakVisibleAssistant(sessionId, ASSISTANT);
    visibleTtsText = tts.text;
    visibleTtsExcludesSecret = tts.visibleOnly && tts.text === VISIBLE && !tts.wire.includes(SECRET);
    say(lines, `B1 幂等读取 assistant 仍含隐藏字段，两次结果一致=${b1Idempotent}`);
    say(lines, `B2 会话 ${sessionId} 幂等=${idempotentSession} SESSION_BUSY=${sessionBusy}`);
    say(lines, `eventId 去重 duplicate=${duplicate.duplicate} 保留 ${pulled.events.length} 条`);
    say(lines, `assistant.visible TTS text=${tts.text} 报文含隐藏字段=${tts.wire.includes(SECRET)}`);
  });

  let duplicateSurvivedRestart = false;
  let refreshRotated = false;
  let oldTokenRejected = false;
  let cursorExpired = false;
  let lateCameraCode = "";
  let flashCode = "";
  let massFlashCode = "";
  let refreshedToken = "";

  await withDb(statePath, (db) => {
    const plane = new ControlPlane({ store: db, ...generators, now: clock });
    const book = new SessionBook({ plane, store: db, now: clock });
    const afterReload = book.append(sessionId, { eventId: "evt-sim-1", type: "device.heartbeat" });
    const pulled = book.pull(sessionId, 0);
    duplicateSurvivedRestart = afterReload.duplicate && pulled.events.length === 1;
    say(lines, `重启后 eventId 仍去重 duplicate=${afterReload.duplicate}`);

    const issued = plane.issueConnectionCredential(DEVICE_ID);
    const refreshed = plane.refreshConnectionCredential(DEVICE_ID, issued.token);
    refreshedToken = refreshed.token;
    refreshRotated = issued.token !== refreshed.token;
    const staleCode = catchCode(() =>
      plane.submitCameraResult({
        deviceId: DEVICE_ID,
        token: issued.token,
        capturedAtMs: now - 1_000,
        frameBytes: 128,
      }),
    );
    const accepted = plane.submitCameraResult({
      deviceId: DEVICE_ID,
      token: refreshed.token,
      capturedAtMs: now - 1_000,
      frameBytes: 128,
    });
    oldTokenRejected = staleCode === "credential_missing" && accepted.accepted && accepted.storedImage === false;
    say(lines, `refresh stub ${issued.token} -> ${refreshed.token}，旧 token 摄像头=${staleCode}`);

    now += SESSION_CURSOR_TTL_MS;
    cursorExpired = catchCode(() => book.pull(sessionId, 0)) === "CURSOR_EXPIRED";
    const stillLive = plane.submitCameraResult({
      deviceId: DEVICE_ID,
      token: refreshed.token,
      capturedAtMs: now - 1_000,
      frameBytes: 64,
    });
    say(lines, `CURSOR_EXPIRED=${cursorExpired}，凭证未过期所以摄像头仍 accepted=${stillLive.accepted}`);

    plane.revoke(DEVICE_ID);
    lateCameraCode = catchCode(() =>
      plane.submitCameraResult({
        deviceId: DEVICE_ID,
        token: refreshed.token,
        capturedAtMs: now - SESSION_CURSOR_TTL_MS - 1_000,
        frameBytes: 64,
      }),
    );
    const refreshCode = catchCode(() => plane.refreshConnectionCredential(DEVICE_ID, refreshed.token));
    flashCode = catchCode(() => plane.flash());
    massFlashCode = catchCode(() => plane.massFlash());
    const ota = plane.proposeLabOta({ deviceId: DEVICE_ID, version: "lab-sim" });
    if (ota.firmwareUrl !== null || ota.executable !== false || ota.force !== 0) {
      throw new Error("simulator stored an executable OTA record");
    }
    say(lines, `吊销后迟到摄像头=${lateCameraCode} refresh=${refreshCode}`);
    say(lines, `flash=${flashCode} massFlash=${massFlashCode} firmwareUrl=null executable=false`);
    if (refreshCode !== "credential_revoked") {
      throw new Error("revoke did not block credential refresh");
    }
  });

  let reloadedRevoked = false;
  let reloadedLateCameraCode = "";
  let reloadedCursorExpired = false;
  let reloadedSessionClosed = false;
  let reloadedAssistant = false;
  await withDb(statePath, (db) => {
    const plane = new ControlPlane({ store: db, now: clock });
    const book = new SessionBook({ plane, store: db, now: clock });
    const binding = plane.getBinding(DEVICE_ID);
    reloadedAssistant = binding !== undefined && assistantEqual(binding.assistant, ASSISTANT);
    reloadedRevoked = plane.isRevoked(DEVICE_ID) && plane.activeCredentialCount(DEVICE_ID) === 0;
    reloadedLateCameraCode = catchCode(() =>
      plane.submitCameraResult({
        deviceId: DEVICE_ID,
        token: refreshedToken,
        capturedAtMs: now - 1_000,
        frameBytes: 32,
      }),
    );
    reloadedCursorExpired = catchCode(() => book.pull(sessionId, 0)) === "CURSOR_EXPIRED";
    if (binding) {
      reloadedSessionClosed =
        catchCode(() =>
          book.open({
            authorizationRef: binding.authorizationRef,
            bindingVersion: binding.bindingVersion,
            digitalHumanId: binding.digitalHumanId,
            deviceId: binding.deviceId,
            idempotencyKey: "sim-after-restart",
          }),
        ) === "SESSION_CLOSED";
    }
    const ota = plane.getLabOta(DEVICE_ID);
    if (!ota || ota.executable !== false || ota.firmwareUrl !== null) {
      throw new Error("reloaded OTA record is executable");
    }
    say(lines, "再次打开状态文件");
    say(lines, `  revoked=${reloadedRevoked} 迟到摄像头=${reloadedLateCameraCode}`);
    say(lines, `  CURSOR_EXPIRED=${reloadedCursorExpired} SESSION_CLOSED=${reloadedSessionClosed}`);
    say(lines, `  assistant 保持=${reloadedAssistant} ota executable=${ota.executable}`);
  });

  if (!b1Idempotent || !assistantPreserved || !reloadedAssistant) {
    throw new Error("assistant contract drifted in the simulator");
  }
  if (!idempotentSession || !sessionBusy || !duplicateEventIgnored || !duplicateSurvivedRestart) {
    throw new Error("B2 stand-in did not keep idempotency, SESSION_BUSY, or eventId dedupe");
  }
  if (!cursorExpired || !reloadedCursorExpired || !reloadedSessionClosed) {
    throw new Error("cursor expiry did not stay closed across restart");
  }
  if (!visibleTtsExcludesSecret || visibleTtsText !== VISIBLE) {
    throw new Error("TTS was not limited to assistant.visible.speech");
  }
  if (!refreshRotated || !oldTokenRejected || lateCameraCode !== "camera_revoked" || reloadedLateCameraCode !== "camera_revoked") {
    throw new Error("reconnect or late camera rejection failed");
  }
  if (!reloadedRevoked || flashCode !== "ota_disabled" || massFlashCode !== "mass_flash") {
    throw new Error("revoke persistence or flash hard-fail failed");
  }

  return {
    lines,
    contractSha: OPENBOT_CONTRACT_SHA,
    b1Idempotent,
    assistantPreserved,
    sessionId,
    idempotentSession,
    sessionBusy,
    duplicateEventIgnored,
    duplicateSurvivedRestart,
    cursorExpired,
    visibleTtsText,
    visibleTtsExcludesSecret,
    refreshRotated,
    oldTokenRejected,
    lateCameraCode,
    flashCode,
    massFlashCode,
    otaFirmwareUrl: null,
    otaExecutable: false,
    reloadedRevoked,
    reloadedLateCameraCode,
    reloadedCursorExpired,
    reloadedSessionClosed,
  };
}

async function withDb<T>(path: string, fn: (db: StagingDb) => Promise<T> | T): Promise<T> {
  const db = openStaging(path);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function resetState(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function say(lines: string[], line: string): void {
  lines.push(line);
}

function catchCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SessionError) {
      return error.code;
    }
    if (error instanceof ControlPlaneError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected stand-in error");
}

function assertPinnedSha(): void {
  if (OPENBOT_CONTRACT_SHA !== PINNED_SHA) {
    throw new Error("OPENBOT_CONTRACT_SHA drifted from the official main SHA");
  }
}
