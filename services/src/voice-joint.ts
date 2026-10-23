import { Buffer } from "node:buffer";

import {
  GRANT_CREDENTIAL_HEADER,
  LIVE_STUB_ENV,
  STUB_DEVICE_ID_ENV,
  STUB_GRANT_CREDENTIAL_ENV,
  STUB_SERVICE_PASSWORD_ENV,
  STUB_SERVICE_USER_ENV,
  serviceBasicFromEnv,
  stubLocationFromEnv,
} from "../../contracts/src/index.ts";
import { buildWavPcm } from "../../adapters/voice/src/index.ts";
import { DEVICE_CONTROL_API_PREFIX } from "./device-control.ts";

/** Evidence still missing after upload+messages loopback. Not an end-to-end pass.
 * `npm run voice-joint` = HTTP compat smoke (silent WAV + optional transcript=).
 * It is NOT voice E2E — see docs/voice-longitudinal-harness.md.
 */
export const VOICE_JOINT_PENDING = ["ui", "staging", "real-device", "production"] as const;

/** Optional device-control origin for dual-command health probe (not required for upload). */
export const VOICE_JOINT_CONTROL_URL_ENV = "OPENBOT_VOICE_JOINT_CONTROL_URL";

/** Passthrough transcript query value (ASR/passthrough — not assistant.final). */
export const VOICE_JOINT_TRANSCRIPT_ENV = "OPENBOT_VOICE_JOINT_TRANSCRIPT";

/** Firmware / gateway compat header; must equal grant.deviceId (B1 claw4-firmware-http-compat). */
export const DEVICE_ID_HEADER = "X-Device-Id";

const REQUIRED_ENV = [
  LIVE_STUB_ENV,
  STUB_SERVICE_USER_ENV,
  STUB_SERVICE_PASSWORD_ENV,
  STUB_GRANT_CREDENTIAL_ENV,
  STUB_DEVICE_ID_ENV,
] as const;

export function voiceJointMissingEnv(env: NodeJS.ProcessEnv): string[] {
  return REQUIRED_ENV.filter((name) => {
    const value = env[name];
    return value === undefined || value.length === 0;
  });
}

export interface VoiceJointCheck {
  name: string;
  layer: "voice-joint";
  proof: "api";
  ok: true;
}

export interface VoiceJointReport {
  layer: "voice-joint";
  proof: "api";
  stubOrigin: string;
  transcript: string;
  conversationId: string;
  uploadText: string;
  messagesOk: true;
  controlHealthOk: boolean | null;
  controlMaturity: string | undefined;
  checks: VoiceJointCheck[];
  pending: typeof VOICE_JOINT_PENDING;
  /** Explicit: this harness does not expand npm run sim. */
  simUnchanged: true;
}

export interface VoiceJointOptions {
  env: NodeJS.ProcessEnv;
  /** Override passthrough transcript (default claw4-upload-smoke or env). */
  transcript?: string;
  fetchImpl?: typeof fetch;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing env ${name}`);
  }
  return value;
}

function silentWav(): Buffer {
  return buildWavPcm({
    pcm: Buffer.alloc(640),
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
  });
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const service = serviceBasicFromEnv(env);
  const grant = env[STUB_GRANT_CREDENTIAL_ENV];
  const deviceId = env[STUB_DEVICE_ID_ENV];
  if (service === undefined || grant === undefined || grant.length === 0 || deviceId === undefined || deviceId.length === 0) {
    throw new Error("service basic, grant credential, and device id are required together");
  }
  return {
    Authorization: service.authorization,
    [GRANT_CREDENTIAL_HEADER]: grant,
    [DEVICE_ID_HEADER]: deviceId,
  };
}

/**
 * HTTP compat smoke for B1 claw4 firmware HTTP compat on stub :8787
 * (`npm run voice-joint`). Silent WAV + optional ?transcript= passthrough —
 * NOT voice E2E (no real ASR/TTS path). See docs/voice-longitudinal-harness.md.
 * POSTs /api/v1/upload?transcript= then GETs conversation messages.
 * Optionally probes device-control health when OPENBOT_VOICE_JOINT_CONTROL_URL is set.
 * Does not implement gateway routes, does not touch npm run sim, does not mint grants.
 */
export async function runVoiceJointLoopback(options: VoiceJointOptions): Promise<VoiceJointReport> {
  const missing = voiceJointMissingEnv(options.env);
  if (missing.length > 0) {
    throw new Error(`voice joint loopback missing env: ${missing.join(", ")}`);
  }
  const location = stubLocationFromEnv(options.env);
  if (location === undefined) {
    throw new Error(`${LIVE_STUB_ENV} is required`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const transcript =
    options.transcript !== undefined && options.transcript.length > 0
      ? options.transcript
      : (options.env[VOICE_JOINT_TRANSCRIPT_ENV] ?? "claw4-upload-smoke");
  const headers = authHeaders(options.env);
  const checks: VoiceJointCheck[] = [];
  const mark = (name: string): void => {
    checks.push({ name, layer: "voice-joint", proof: "api", ok: true });
  };

  const healthRes = await fetchImpl(`${location.origin}/healthz`, { method: "GET" });
  if (!healthRes.ok) {
    throw new Error(`stub healthz HTTP ${healthRes.status} (primary path is stub :8787; gateway :18789 may 503 without DeviceDhService)`);
  }
  mark("stub.healthz");

  const uploadUrl = new URL("/api/v1/upload", location.origin);
  uploadUrl.searchParams.set("transcript", transcript);
  const uploadRes = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "audio/wav",
    },
    body: new Uint8Array(silentWav()),
  });
  const uploadBody = (await uploadRes.json()) as {
    code?: number;
    data?: { text?: string; conversationId?: string };
    error?: { code?: string; message?: string };
  };
  if (!uploadRes.ok || uploadBody.code !== 0 || uploadBody.data === undefined) {
    throw new Error(
      `upload failed HTTP ${uploadRes.status} code=${String(uploadBody.code)} error=${uploadBody.error?.code ?? "?"}: ${uploadBody.error?.message ?? ""}`,
    );
  }
  const uploadText = uploadBody.data.text ?? "";
  const conversationId = uploadBody.data.conversationId ?? "";
  if (uploadText !== transcript) {
    throw new Error(`data.text must be ASR/passthrough transcript; got ${JSON.stringify(uploadText)} want ${JSON.stringify(transcript)}`);
  }
  if (conversationId.length === 0) {
    throw new Error("upload response missing data.conversationId");
  }
  mark("claw4.upload.passthrough");

  const messagesUrl = `${location.origin}/api/v1/conversation/${encodeURIComponent(conversationId)}/messages`;
  const messagesRes = await fetchImpl(messagesUrl, {
    method: "GET",
    headers,
  });
  const messagesBody = (await messagesRes.json()) as {
    code?: number;
    data?: { conversationId?: string; messages?: unknown };
    error?: { code?: string };
  };
  if (!messagesRes.ok || messagesBody.code !== 0) {
    throw new Error(`messages failed HTTP ${messagesRes.status} code=${String(messagesBody.code)} error=${messagesBody.error?.code ?? "?"}`);
  }
  mark("claw4.conversation.messages");

  let controlHealthOk: boolean | null = null;
  let controlMaturity: string | undefined;
  const controlRaw = options.env[VOICE_JOINT_CONTROL_URL_ENV];
  if (controlRaw !== undefined && controlRaw.length > 0) {
    const controlOrigin = controlRaw.replace(/\/$/, "");
    const controlHealthUrl = `${controlOrigin}${DEVICE_CONTROL_API_PREFIX}/health`;
    const controlRes = await fetchImpl(controlHealthUrl, { method: "GET" });
    const controlBody = (await controlRes.json().catch(() => ({}))) as { maturity?: string };
    controlHealthOk = controlRes.ok;
    controlMaturity = typeof controlBody.maturity === "string" ? controlBody.maturity : undefined;
    if (!controlRes.ok) {
      throw new Error(`device-control health HTTP ${controlRes.status} at ${controlHealthUrl}`);
    }
    mark("device-control.health.dual-command");
  }

  return {
    layer: "voice-joint",
    proof: "api",
    stubOrigin: location.origin,
    transcript,
    conversationId,
    uploadText,
    messagesOk: true,
    controlHealthOk,
    controlMaturity,
    checks,
    pending: VOICE_JOINT_PENDING,
    simUnchanged: true,
  };
}

export function formatVoiceJointReport(report: VoiceJointReport): string {
  const lines: string[] = [
    "voice-joint / HTTP compat smoke (claw4 upload+messages on stub; NOT voice E2E; NOT npm run sim)",
    `stubOrigin: ${report.stubOrigin}`,
    `transcript(passthrough): ${report.transcript}`,
    `conversationId: ${report.conversationId}`,
    `uploadText===transcript: ${report.uploadText === report.transcript}`,
    `messagesOk: ${report.messagesOk}`,
    `simUnchanged: ${report.simUnchanged}`,
  ];
  if (report.controlHealthOk === null) {
    lines.push("device-control: skipped (set OPENBOT_VOICE_JOINT_CONTROL_URL for dual-command)");
  } else {
    lines.push(`device-control.healthOk: ${report.controlHealthOk}`);
    if (report.controlMaturity !== undefined) {
      lines.push(`device-control.maturity: ${report.controlMaturity}`);
    }
  }
  for (const check of report.checks) {
    lines.push(`ok ${check.name} [${check.layer}/${check.proof}]`);
  }
  lines.push(`JOINT_PENDING: ${report.pending.join("、")}`);
  lines.push("HTTP compat smoke only: silent WAV + optional transcript= is NOT voice E2E.");
  lines.push("data.text = ASR/passthrough (not assistant.final). Primary path stub :8787; gateway :18789 may 503 without DeviceDhService.");
  lines.push("Authority: openbot-vp docs/integrations/device-digital-human/claw4-firmware-http-compat.md");
  return lines.join("\n");
}
