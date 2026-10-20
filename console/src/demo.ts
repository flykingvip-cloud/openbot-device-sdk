import { rmSync } from "node:fs";

import { OPENBOT_CONTRACT_SHA } from "../../contracts/src/index.ts";
import { assistantEqual, type AssistantFields } from "../../contracts/src/index.ts";
import {
  ControlPlane,
  ControlPlaneError,
  openStaging,
  type LabOtaIntent,
  type StagingDb,
} from "../../services/src/index.ts";

const PINNED_SHA = "d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f";
const PIN_LINE =
  "正式针: openbot-vp main，PR #17 的 squash merge。已作废: 490a69669c0cf9e68173ceb25cfa89c99438dfb9、feeac51863d6d88ba83c7e16029b2911209bb0d0、fe1e2c2a81fd3814e8588a854695640ca56db64b、92826116a9b00a596ae2360d8a643d6148050e3c、d22db4755311a1a0df9fb5e3d5da60554f8ef6a5、bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a、41b7561222775e4ad00b056e2a535c7f950bcbe9、536a963b119f0a00675516401c52dd0f6187b196、8abdc7f9a0ae49c340de712fbba235b1064f6c7d、554910d835f3baadb1d753532ad510b1b477be09 与更早的 dd6c85cae086d90c519ff1be7ad08e20d4644bba。";
const ACCESS_LINE =
  "OpenAPI 路径仍按冻结前缀对齐。针是 d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f。字段名未改，入库字节不换（更早的树拉取曾返回 404）。routesAligned 为 true，只表示静态 OpenAPI 对齐，不是端到端联调。B2–B5 仍用本地 stand-in。";
const DEVICE_ID = "dev-console";
const DIGITAL_HUMAN_ID = "dh-console";
const NOW = 1_700_000_000_000;

const ASSISTANT: AssistantFields = {
  voiceId: "voice-lab",
  locale: "zh-CN",
  nested: { style: "calm" },
};

export interface ConsoleDemoResult {
  lines: string[];
  contractSha: string;
  deviceId: string;
  claimCode: string;
  bindingVersion: number;
  authorizationRef: string;
  assistantPreserved: boolean;
  otaExecutable: false;
  otaFirmwareUrl: null;
  flashCode: string;
  massFlashCode: string;
  refreshRotated: boolean;
  staleCameraCode: string;
  lateCameraCode: string;
  reloadedBindingVersion: number;
  reloadedLateCameraCode: string;
  reloadedAssistantPreserved: boolean;
  reloadedRevoked: boolean;
}

export interface ConsoleResumeResult {
  lines: string[];
  contractSha: string;
  deviceId: string;
  bindingVersion: number;
  authorizationRef: string;
  revoked: boolean;
  otaExecutable: false | null;
  otaFirmwareUrl: null;
  cameraCode: string;
}

export function runConsoleDemo(statePath: string): ConsoleDemoResult {
  assertPinnedSha();
  resetState(statePath);
  let refs = 0;
  let tokens = 0;
  const lines: string[] = [];
  say(lines, "设备控制台（实验，无真机）");
  say(lines, `状态: ${statePath}`);
  say(lines, `合约针: ${OPENBOT_CONTRACT_SHA}`);
  say(lines, PIN_LINE);
  say(lines, ACCESS_LINE);

  let claimCode = "";
  let authorizationRef = "";
  let bindingVersion = 0;
  let assistantPreserved = false;
  let ota: LabOtaIntent | undefined;
  let flashCode = "";
  let massFlashCode = "";
  let refreshRotated = false;
  let staleCameraCode = "";
  let lateCameraCode = "";
  let issuedToken = "";
  let refreshedToken = "";

  withDb(statePath, (db) => {
    const plane = new ControlPlane({
      store: db,
      now: () => NOW,
      code: () => "042315",
      authorizationRef: () => {
        refs += 1;
        return `aref_demo_${refs}`;
      },
      token: () => {
        tokens += 1;
        return `ctok_demo_${tokens}`;
      },
    });
    const ticket = plane.issueClaim(DEVICE_ID);
    claimCode = ticket.code;
    say(lines, "认领");
    say(lines, `  设备 ${DEVICE_ID} 发出 6 位认领码 ${ticket.code}`);
    plane.redeemClaim(DEVICE_ID, ticket.code);
    say(lines, "  认领码已核销");

    const first = plane.bind({
      deviceId: DEVICE_ID,
      digitalHumanId: DIGITAL_HUMAN_ID,
      assistant: ASSISTANT,
    });
    const second = plane.rebind(DEVICE_ID, { digitalHumanId: DIGITAL_HUMAN_ID });
    authorizationRef = second.authorizationRef;
    bindingVersion = second.bindingVersion;
    assistantPreserved = assistantEqual(second.assistant, first.assistant) && assistantEqual(second.assistant, ASSISTANT);
    say(lines, "绑定");
    say(lines, `  首次 authorizationRef=${first.authorizationRef} bindingVersion=${first.bindingVersion}`);
    say(lines, `  rebind 后 authorizationRef=${second.authorizationRef} bindingVersion=${second.bindingVersion}`);
    say(lines, assistantPreserved ? "  assistant 原样保留" : "  assistant 发生变化");

    ota = plane.proposeLabOta({ deviceId: DEVICE_ID, version: "lab-0" });
    flashCode = catchCode(() => plane.flash());
    massFlashCode = catchCode(() => plane.massFlash());
    say(lines, "OTA");
    say(lines, `  单设备实验记录 version=${ota.version} executable=${ota.executable} firmwareUrl=null force=${ota.force}`);
    say(lines, `  flash 失败: ${flashCode}`);
    say(lines, `  massFlash 失败: ${massFlashCode}`);

    const issued = plane.issueConnectionCredential(DEVICE_ID);
    const refreshed = plane.refreshConnectionCredential(DEVICE_ID, issued.token);
    issuedToken = issued.token;
    refreshedToken = refreshed.token;
    refreshRotated = issued.token !== refreshed.token && plane.getConnectionCredential(issued.token) === undefined;
    staleCameraCode = catchCode(() =>
      plane.submitCameraResult({
        deviceId: DEVICE_ID,
        token: issued.token,
        capturedAtMs: NOW - 1_000,
        frameBytes: 128,
      }),
    );
    say(lines, "重连");
    say(lines, `  签发短时连接凭证 ${issued.token}`);
    say(lines, `  refresh stub 轮换为 ${refreshed.token}（本地 stub，不访问网络）`);
    say(lines, `  旧凭证提交摄像头被拒绝: ${staleCameraCode}`);

    const cleared = plane.revoke(DEVICE_ID);
    lateCameraCode = catchCode(() =>
      plane.submitCameraResult({
        deviceId: DEVICE_ID,
        token: refreshed.token,
        capturedAtMs: NOW - 5_000,
        frameBytes: 128,
      }),
    );
    say(lines, "吊销");
    say(lines, `  已清空短时 token ${cleared.clearedTokens} 个，冻结绑定仍在`);
    say(lines, `  迟到的摄像头结果被拒绝: ${lateCameraCode}`);
  });

  let reloadedBindingVersion = 0;
  let reloadedLateCameraCode = "";
  let reloadedAssistantPreserved = false;
  let reloadedRevoked = false;
  withDb(statePath, (db) => {
    const plane = new ControlPlane({ store: db, now: () => NOW });
    const binding = plane.getBinding(DEVICE_ID);
    const loadedOta = plane.getLabOta(DEVICE_ID);
    if (!binding || !loadedOta) {
      throw new Error("重启后没有读回绑定或 OTA 记录");
    }
    reloadedBindingVersion = binding.bindingVersion;
    reloadedAssistantPreserved = assistantEqual(binding.assistant, ASSISTANT) && binding.authorizationRef === authorizationRef;
    reloadedRevoked = plane.isRevoked(DEVICE_ID) && plane.activeCredentialCount(DEVICE_ID) === 0;
    reloadedLateCameraCode = catchCode(() =>
      plane.submitCameraResult({
        deviceId: DEVICE_ID,
        token: refreshedToken,
        capturedAtMs: NOW - 5_000,
        frameBytes: 128,
      }),
    );
    if (loadedOta.firmwareUrl !== null || loadedOta.executable !== false || loadedOta.force !== 0) {
      throw new Error("重启后的 OTA 记录不再是不可执行的实验记录");
    }
    say(lines, "重启");
    say(lines, `  重新打开状态文件后 bindingVersion=${binding.bindingVersion} authorizationRef=${binding.authorizationRef}`);
    say(lines, reloadedAssistantPreserved ? "  assistant 仍然一致" : "  assistant 不一致");
    say(lines, `  吊销仍然有效=${reloadedRevoked}，摄像头结果仍被拒绝: ${reloadedLateCameraCode}`);
  });

  if (!assistantPreserved || !reloadedAssistantPreserved) {
    throw new Error("assistant.* changed across rebind or restart");
  }
  if (ota === undefined || ota.executable !== false || ota.firmwareUrl !== null) {
    throw new Error("lab OTA record became executable");
  }
  if (flashCode !== "ota_disabled" || massFlashCode !== "mass_flash") {
    throw new Error("flash or massFlash did not hard-fail");
  }
  if (!refreshRotated || staleCameraCode !== "credential_missing" || lateCameraCode !== "camera_revoked") {
    throw new Error("reconnect or revoke path did not fail closed");
  }
  if (reloadedLateCameraCode !== "camera_revoked" || !reloadedRevoked || reloadedBindingVersion !== bindingVersion) {
    throw new Error("restart did not keep the revoked control plane");
  }
  if (issuedToken === refreshedToken) {
    throw new Error("refresh stub did not rotate the token");
  }

  return {
    lines,
    contractSha: OPENBOT_CONTRACT_SHA,
    deviceId: DEVICE_ID,
    claimCode,
    bindingVersion,
    authorizationRef,
    assistantPreserved,
    otaExecutable: false,
    otaFirmwareUrl: null,
    flashCode,
    massFlashCode,
    refreshRotated,
    staleCameraCode,
    lateCameraCode,
    reloadedBindingVersion,
    reloadedLateCameraCode,
    reloadedAssistantPreserved,
    reloadedRevoked,
  };
}

export function runConsoleResume(statePath: string): ConsoleResumeResult {
  assertPinnedSha();
  const lines: string[] = [];
  return withDb(statePath, (db) => {
    const plane = new ControlPlane({ store: db, now: () => NOW });
    const binding = plane.getBinding(DEVICE_ID);
    if (!binding) {
      throw new Error("状态文件里没有绑定。先运行 npm run console");
    }
    const ota = plane.getLabOta(DEVICE_ID);
    const cameraCode = catchCode(() =>
      plane.submitCameraResult({
        deviceId: DEVICE_ID,
        token: "resume-probe",
        capturedAtMs: NOW,
        frameBytes: 1,
      }),
    );
    say(lines, "恢复状态");
    say(lines, `合约针: ${OPENBOT_CONTRACT_SHA}`);
    say(lines, PIN_LINE);
    say(lines, ACCESS_LINE);
    say(lines, `  deviceId=${binding.deviceId}`);
    say(lines, `  bindingVersion=${binding.bindingVersion}`);
    say(lines, `  authorizationRef=${binding.authorizationRef}`);
    say(lines, `  revoked=${plane.isRevoked(DEVICE_ID)}`);
    say(lines, `  ota executable=${ota?.executable ?? "missing"} firmwareUrl=null`);
    say(lines, `  摄像头探针被拒绝: ${cameraCode}`);
    return {
      lines,
      contractSha: OPENBOT_CONTRACT_SHA,
      deviceId: binding.deviceId,
      bindingVersion: binding.bindingVersion,
      authorizationRef: binding.authorizationRef,
      revoked: plane.isRevoked(DEVICE_ID),
      otaExecutable: ota ? false : null,
      otaFirmwareUrl: null,
      cameraCode,
    };
  });
}

function withDb<T>(path: string, fn: (db: StagingDb) => T): T {
  const db = openStaging(path);
  try {
    return fn(db);
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
    if (error instanceof ControlPlaneError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected control-plane error");
}

function assertPinnedSha(): void {
  if (OPENBOT_CONTRACT_SHA !== PINNED_SHA) {
    throw new Error("OPENBOT_CONTRACT_SHA drifted from the official main SHA");
  }
}
