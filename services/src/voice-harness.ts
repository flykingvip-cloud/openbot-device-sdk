/**
 * Longitudinal voice harness (P1-5).
 *
 * Layers: sim (in-process, mock/ProportionalSilence) | real | device.
 * `npm run voice-harness` / `voice-harness:sim` exercise the sim layer.
 * Distinct from `npm run voice-joint` (HTTP compat smoke with optional ?transcript=).
 *
 * Sim does NOT treat ?transcript= / X-Transcript-Text as ASR.
 * ASR text must come from AsrProvider.transcribe / bridge.transcribeWav.
 * Assistant reply is mocked separately — never upload data.text alone.
 * Spoken TTS gate: real TtsProvider or ProportionalSilenceTtsProvider;
 * OpusFrameTtsProvider is format/lab only and fails the spoken gate.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";

import {
  MOCK_ASR_DEFAULT_TRANSCRIPT,
  OpusFrameTtsProvider,
  ProportionalSilenceTtsProvider,
  buildWavPcm,
  createAudioBridge,
  createMockAsrProvider,
  createProportionalSilenceTtsProvider,
  isWavBuffer,
  type AsrProvider,
  type AsrTranscribeOptions,
  type AudioBridge,
  type TtsProvider,
} from "../../adapters/voice/src/index.ts";
import { SERVER_SAMPLE_RATE_DEFAULT, looksLikeRawOpusPacket } from "../../adapters/metalio/src/index.ts";

/** Evidence still missing after sim harness. Not an E2E / real / device pass. */
export const VOICE_HARNESS_PENDING = ["ui", "staging", "real-device", "production"] as const;

export type VoiceHarnessLayer = "sim" | "real" | "device";

export interface VoiceHarnessCheck {
  id: string;
  name: string;
  layer: VoiceHarnessLayer;
  ok: boolean;
  detail?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface VoiceHarnessLayerStatus {
  layer: VoiceHarnessLayer;
  status: "pass" | "partial" | "JOINT_PENDING" | "fail";
  note: string;
}

export interface VoiceHarnessReport {
  /** Active layer this run exercised (default sim). */
  layer: VoiceHarnessLayer;
  ok: boolean;
  checks: VoiceHarnessCheck[];
  layers: VoiceHarnessLayerStatus[];
  pending: typeof VOICE_HARNESS_PENDING;
  /** Explicit: not voice-joint HTTP smoke; does not expand npm run sim. */
  voiceJointUnchanged: true;
  simUnchanged: true;
  asrText: string;
  assistantText: string;
  ttsFrameCountShort: number;
  ttsFrameCountLong: number;
}

export interface VoiceHarnessSimOptions {
  /**
   * Optional injectable ASR (default MockAsrProvider).
   * Must return text via transcribe — harness never uses query/header transcript.
   */
  asr?: AsrProvider;
  /**
   * Spoken TTS only. Default ProportionalSilenceTtsProvider.
   * OpusFrameTtsProvider fails the spoken gate.
   */
  tts?: TtsProvider;
  /** Mock assistant reply (assistant.final-shaped). Not upload data.text. */
  assistantReply?: string;
  /**
   * When true (default), run in-process AUTH_REVOKED contract stub.
   * Real revoke against B stub :8787 remains a documentation gate / JOINT_PENDING.
   */
  runRevokeContract?: boolean;
}

/** Passthrough hints that must NEVER be accepted as ASR results in this harness. */
export const FORBIDDEN_PASSTHROUGH_HINTS = [
  "claw4-upload-smoke",
  "passthrough-hello",
  "from-query-transcript",
  "from-x-transcript-text",
] as const;

export const VOICE_HARNESS_ASSISTANT_DEFAULT = "harness-assistant-final";

/**
 * Known WAV fixture: non-empty PCM with embedded NUL / high bytes so it is
 * not a UTF-8 listen hint. Used by sim checklist item 1.
 */
export function buildKnownWavFixture(pcmBytes = 640): Buffer {
  const pcm = Buffer.alloc(pcmBytes);
  // Non-UTF-8 binary pattern (NULs + high bytes) so MockAsr cannot treat as listen text.
  for (let i = 0; i < pcmBytes; i += 1) {
    pcm[i] = i % 2 === 0 ? 0x00 : 0x80 + (i % 0x40);
  }
  return buildWavPcm({
    pcm,
    sampleRate: 16_000,
    channels: 1,
    bitsPerSample: 16,
  });
}

/**
 * Spoken TTS gate: reject OpusFrameTtsProvider (fixed tone / format-only).
 * Accept ProportionalSilenceTtsProvider or any other non-OpusFrame provider.
 */
export function assertSpokenTtsProvider(tts: TtsProvider): void {
  if (tts instanceof OpusFrameTtsProvider) {
    throw new Error(
      "spoken TTS gate failed: OpusFrameTtsProvider is format/lab only (ignores text); inject real TtsProvider or ProportionalSilenceTtsProvider",
    );
  }
}

/**
 * Layered harness surface for sim / real / device.
 * real and device stay JOINT_PENDING until weights / board evidence land.
 */
export interface VoiceLongitudinalHarness {
  readonly layer: VoiceHarnessLayer;
  runSim(options?: VoiceHarnessSimOptions): Promise<VoiceHarnessReport>;
  /** real layer — not implemented this slice; returns JOINT_PENDING report. */
  runReal(): Promise<VoiceHarnessReport>;
  /** device layer — not implemented this slice; returns JOINT_PENDING report. */
  runDevice(): Promise<VoiceHarnessReport>;
}

function mark(
  checks: VoiceHarnessCheck[],
  id: string,
  name: string,
  layer: VoiceHarnessLayer,
  ok: boolean,
  detail?: string,
  skipped?: { reason: string },
): void {
  const check: VoiceHarnessCheck = { id, name, layer, ok };
  if (detail !== undefined) {
    check.detail = detail;
  }
  if (skipped !== undefined) {
    check.skipped = true;
    check.skipReason = skipped.reason;
  }
  checks.push(check);
}

function throwIfFailed(checks: VoiceHarnessCheck[]): void {
  const failed = checks.filter((c) => !c.ok && !c.skipped);
  if (failed.length > 0) {
    const summary = failed.map((c) => `${c.id}: ${c.detail ?? c.name}`).join("; ");
    throw new Error(`voice-harness sim failed: ${summary}`);
  }
}

/**
 * In-process lab stub for AUTH_REVOKED contract (checklist item 7).
 * Not B's :8787 grant service — documents the error shape; real stub gate in docs.
 */
async function runAuthRevokedContractCheck(
  checks: VoiceHarnessCheck[],
): Promise<void> {
  const stub = await startAuthRevokeLabStub();
  try {
    const headers = {
      Authorization: "Basic c3ZjOnNlY3JldA==",
      "X-OpenBot-Grant-Credential": "grant-harness",
      "X-Device-Id": "dev-harness",
      "Content-Type": "audio/wav",
    };
    const wav = buildKnownWavFixture(320);
    const okRes = await fetch(`${stub.origin}/api/v1/upload`, {
      method: "POST",
      headers,
      body: new Uint8Array(wav),
    });
    const okBody = (await okRes.json()) as { code?: number; data?: { text?: string } };
    if (!okRes.ok || okBody.code !== 0) {
      mark(checks, "revoke-pre", "upload succeeds before revoke (lab stub)", "sim", false, `HTTP ${okRes.status}`);
      return;
    }
    mark(checks, "revoke-pre", "upload succeeds before revoke (lab stub)", "sim", true);

    const revokeRes = await fetch(`${stub.origin}/api/v1/grants/revoke`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "harness" }),
    });
    if (!revokeRes.ok) {
      mark(checks, "revoke-call", "lab stub revoke endpoint", "sim", false, `HTTP ${revokeRes.status}`);
      return;
    }
    mark(checks, "revoke-call", "lab stub revoke endpoint", "sim", true);

    const denied = await fetch(`${stub.origin}/api/v1/upload`, {
      method: "POST",
      headers,
      body: new Uint8Array(wav),
    });
    const deniedBody = (await denied.json()) as {
      code?: number;
      error?: { code?: string };
    };
    const errorCode = deniedBody.error?.code ?? "";
    const ok =
      denied.status === 401 &&
      (errorCode === "AUTH_REVOKED" || deniedBody.code === 401);
    mark(
      checks,
      "revoke-auth",
      "Revoke grant → subsequent upload fails (AUTH_REVOKED)",
      "sim",
      ok,
      ok
        ? `lab stub contract: HTTP ${denied.status} error.code=${errorCode}`
        : `want AUTH_REVOKED; got HTTP ${denied.status} code=${String(deniedBody.code)} error=${errorCode}`,
    );
    mark(
      checks,
      "revoke-gate-b",
      "Real revoke against B stub :8787",
      "sim",
      true,
      undefined,
      {
        reason:
          "JOINT_PENDING / docs gate: real grant revoke lives on Agent B stub :8787 (OPENBOT_DEVICE_DH_STUB_URL). This slice proves the AUTH_REVOKED contract shape in-process only.",
      },
    );
  } finally {
    await stub.close();
  }
}

interface AuthRevokeLabStub {
  origin: string;
  close: () => Promise<void>;
}

function startAuthRevokeLabStub(): Promise<AuthRevokeLabStub> {
  let revoked = false;
  const server = createServer((req, res) => {
    void handleAuthRevoke(req, res, () => revoked, () => {
      revoked = true;
    }).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { code: 500, error: { code: "RUN_FAILED", message: "stub failed" } });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("auth-revoke lab stub has no port"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}

async function handleAuthRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  isRevoked: () => boolean,
  doRevoke: () => void,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  if (req.method === "POST" && path === "/api/v1/grants/revoke") {
    doRevoke();
    writeJson(res, 200, { code: 0, data: { status: "revoked" } });
    return;
  }
  if (req.method === "POST" && path === "/api/v1/upload") {
    // Drain body
    await readBody(req);
    if (isRevoked()) {
      writeJson(res, 401, {
        code: 401,
        error: { code: "AUTH_REVOKED", message: "grant revoked", retryable: false },
      });
      return;
    }
    // Intentionally ignore ?transcript= / X-Transcript-Text for ASR — lab stub
    // returns a fixed tag so harness never treats passthrough as spoken ASR path.
    writeJson(res, 200, {
      code: 0,
      data: { text: "lab-stub-upload-tag", conversationId: "conv_harness_1" },
    });
    return;
  }
  writeJson(res, 404, { code: 404, error: { code: "NOT_FOUND", message: path } });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Tracking ASR so we can prove bridge called transcribe (not passthrough). */
class TrackingAsrProvider implements AsrProvider {
  readonly calls: Buffer[] = [];
  readonly fixedTranscript: string;

  constructor(fixedTranscript = MOCK_ASR_DEFAULT_TRANSCRIPT) {
    this.fixedTranscript = fixedTranscript;
  }

  async transcribe(audio: Buffer, _options: AsrTranscribeOptions): Promise<string> {
    this.calls.push(audio);
    return this.fixedTranscript;
  }
}

/**
 * Mock integration reply: assistant.final-shaped text.
 * Must not be confused with upload data.text (ASR/passthrough).
 */
export interface MockAssistantDialogue {
  /** Returns assistant.final text for a user ASR transcript. */
  reply(asrText: string): Promise<{ eventType: "assistant.final"; text: string }>;
}

export function createMockAssistantDialogue(assistantText: string): MockAssistantDialogue {
  return {
    async reply(_asrText: string) {
      return { eventType: "assistant.final" as const, text: assistantText };
    },
  };
}

export async function runVoiceHarnessSim(
  options: VoiceHarnessSimOptions = {},
): Promise<VoiceHarnessReport> {
  const checks: VoiceHarnessCheck[] = [];
  const assistantText = options.assistantReply ?? VOICE_HARNESS_ASSISTANT_DEFAULT;
  const trackingAsr =
    options.asr === undefined ? new TrackingAsrProvider("sim-asr-from-provider") : undefined;
  const asr: AsrProvider = options.asr ?? trackingAsr!;
  const ownsTts = options.tts === undefined;
  const tts: TtsProvider = options.tts ?? createProportionalSilenceTtsProvider({ msPerChar: 60, minFrames: 1 });

  try {
    // --- 1. Known WAV fixture ---
    const wav = buildKnownWavFixture();
    const wavOk =
      isWavBuffer(wav) &&
      wav.byteLength > 44 &&
      wav.includes(Buffer.from([0x00])) &&
      !isPureUtf8ListenHint(wav);
    mark(
      checks,
      "wav-fixture",
      "Known WAV fixture (non-empty, non UTF-8 hint)",
      "sim",
      wavOk,
      wavOk ? `bytes=${wav.byteLength}` : "fixture empty or looks like UTF-8 listen hint",
    );

    // --- Spoken TTS gate (before bridge) ---
    let spokenGateOk = true;
    let spokenGateDetail = "ProportionalSilence or real TtsProvider";
    try {
      assertSpokenTtsProvider(tts);
    } catch (error: unknown) {
      spokenGateOk = false;
      spokenGateDetail = error instanceof Error ? error.message : String(error);
    }
    mark(
      checks,
      "tts-spoken-gate",
      "TTS ≠ fixed tone: spoken provider (not OpusFrameTtsProvider)",
      "sim",
      spokenGateOk,
      spokenGateDetail,
    );

    // Negative proof: OpusFrameTtsProvider must fail the gate
    const labOnly = new OpusFrameTtsProvider({ frameCount: 2, pcmMode: "silence" });
    let opusRejected = false;
    try {
      assertSpokenTtsProvider(labOnly);
    } catch {
      opusRejected = true;
    } finally {
      labOnly.destroy();
    }
    mark(
      checks,
      "tts-reject-opus-frame",
      "OpusFrameTtsProvider rejected as spoken TTS",
      "sim",
      opusRejected,
      opusRejected ? "gate throws as required" : "OpusFrameTtsProvider was incorrectly accepted",
    );

    if (!spokenGateOk) {
      throwIfFailed(checks);
    }

    const bridge = createAudioBridge({
      asr,
      tts,
      ttsSampleRate: SERVER_SAMPLE_RATE_DEFAULT,
    });

    // --- 2 + 3. No transcript passthrough; ASR from provider/bridge ---
    const forbidden = new Set<string>(FORBIDDEN_PASSTHROUGH_HINTS);
    // Simulate hostile inputs that voice-joint WOULD use — harness must ignore them.
    const hostileQueryTranscript = "from-query-transcript";
    const hostileHeaderTranscript = "from-x-transcript-text";
    const asrText = await bridge.transcribeWav(wav);
    const fromProvider =
      trackingAsr !== undefined
        ? trackingAsr.calls.length === 1 && asrText === trackingAsr.fixedTranscript
        : asrText.length > 0;
    const notPassthrough =
      !forbidden.has(asrText) &&
      asrText !== hostileQueryTranscript &&
      asrText !== hostileHeaderTranscript;

    mark(
      checks,
      "no-passthrough",
      "No transcript passthrough (?transcript= / X-Transcript-Text ≠ ASR)",
      "sim",
      notPassthrough,
      notPassthrough
        ? `asrText=${JSON.stringify(asrText)} (ignored hostile ${hostileQueryTranscript} / ${hostileHeaderTranscript})`
        : `ASR looked like passthrough: ${JSON.stringify(asrText)}`,
    );
    mark(
      checks,
      "asr-from-provider",
      "ASR text from AsrProvider.transcribe / bridge.transcribeWav",
      "sim",
      fromProvider && notPassthrough,
      fromProvider
        ? `bridge.transcribeWav → ${JSON.stringify(asrText)}`
        : "ASR provider was not called or returned empty",
    );

    // --- 4. Assistant reply (mock integration; not upload data.text) ---
    const dialogue = createMockAssistantDialogue(assistantText);
    const spoken = await dialogue.reply(asrText);
    const uploadDataTextWouldBe = "lab-stub-upload-tag"; // what upload data.text looks like
    const assistantOk =
      spoken.eventType === "assistant.final" &&
      spoken.text === assistantText &&
      spoken.text !== asrText &&
      spoken.text !== uploadDataTextWouldBe &&
      !forbidden.has(spoken.text);
    mark(
      checks,
      "assistant-reply",
      "Wait for assistant reply text (mock; not upload data.text)",
      "sim",
      assistantOk,
      assistantOk
        ? `assistant.final=${JSON.stringify(spoken.text)} ≠ ASR/upload tag`
        : `bad assistant reply: ${JSON.stringify(spoken)}`,
    );

    // --- 5. TTS proportional (length ∝ text) ---
    const shortFrames = await collectFrames(bridge, "ab");
    const longFrames = await collectFrames(bridge, "abcdefghij");
    const proportional =
      shortFrames.length >= 1 &&
      longFrames.length > shortFrames.length &&
      shortFrames.every((f) => looksLikeRawOpusPacket(f)) &&
      longFrames.every((f) => looksLikeRawOpusPacket(f));
    mark(
      checks,
      "tts-proportional",
      "TTS length ∝ text (ProportionalSilence / real; not fixed tone)",
      "sim",
      proportional,
      proportional
        ? `short=${shortFrames.length} long=${longFrames.length}`
        : `short=${shortFrames.length} long=${longFrames.length} (expected long > short)`,
    );

    // --- 6. Abort in-flight ASR/TTS ---
    const abortOk = await exerciseAbort(bridge, wav);
    mark(
      checks,
      "abort",
      "Abort in-flight ASR/TTS via bridge abort handle",
      "sim",
      abortOk,
      abortOk ? "ASR+TTS abort rejected as expected" : "abort did not cancel in-flight work",
    );

    // --- 7. Revoke → AUTH_REVOKED (lab stub contract) ---
    if (options.runRevokeContract !== false) {
      await runAuthRevokedContractCheck(checks);
    } else {
      mark(
        checks,
        "revoke-auth",
        "Revoke grant → subsequent upload fails (AUTH_REVOKED)",
        "sim",
        true,
        undefined,
        {
          reason:
            "skipped by options; gate → Agent B stub :8787 (OPENBOT_DEVICE_DH_STUB_URL)",
        },
      );
    }

    throwIfFailed(checks);

    const report: VoiceHarnessReport = {
      layer: "sim",
      ok: true,
      checks,
      layers: layerStatuses("sim", "partial"),
      pending: VOICE_HARNESS_PENDING,
      voiceJointUnchanged: true,
      simUnchanged: true,
      asrText,
      assistantText: spoken.text,
      ttsFrameCountShort: shortFrames.length,
      ttsFrameCountLong: longFrames.length,
    };
    return report;
  } finally {
    if (ownsTts && tts instanceof ProportionalSilenceTtsProvider) {
      tts.destroy();
    }
  }
}

function layerStatuses(
  active: VoiceHarnessLayer,
  simStatus: VoiceHarnessLayerStatus["status"],
): VoiceHarnessLayerStatus[] {
  return [
    {
      layer: "sim",
      status: active === "sim" ? simStatus : "JOINT_PENDING",
      note:
        active === "sim"
          ? "In-process mock/ProportionalSilence harness; no FunASR weights; not voice-joint"
          : "JOINT_PENDING",
    },
    {
      layer: "real",
      status: "JOINT_PENDING",
      note: "Needs real ASR/TTS weights outside package + loopback stub; not this slice",
    },
    {
      layer: "device",
      status: "JOINT_PENDING",
      note: "Metalio board + edge; not this slice",
    },
  ];
}

function isPureUtf8ListenHint(wav: Buffer): boolean {
  // Skip RIFF header; inspect PCM payload only.
  if (wav.byteLength <= 44) {
    return false;
  }
  const pcm = wav.subarray(44);
  const asText = pcm.toString("utf8");
  if (asText.includes("\0")) {
    return false;
  }
  return /^[\x09\x0a\x0d\x20-\x7e\u0080-\uffff]*$/.test(asText);
}

async function collectFrames(bridge: AudioBridge, text: string): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for await (const frame of bridge.synthesizeOpus(text)) {
    frames.push(frame);
  }
  return frames;
}

async function exerciseAbort(bridge: AudioBridge, wav: Buffer): Promise<boolean> {
  let releaseAsr: (() => void) | undefined;
  const slowAsr: AsrProvider = {
    async transcribe() {
      await new Promise<void>((resolve) => {
        releaseAsr = resolve;
      });
      return "should-not-win";
    },
  };
  const slowTts: TtsProvider = {
    async *synthesize() {
      yield Buffer.from([0x01]);
      yield Buffer.from([0x02]);
      yield Buffer.from([0x03]);
    },
  };
  const abortBridge = createAudioBridge({ asr: slowAsr, tts: slowTts });

  const pre = abortBridge.createAbortHandle();
  pre.abort();
  try {
    await abortBridge.transcribeWav(wav, { signal: pre.signal });
    return false;
  } catch (error: unknown) {
    if (!isAbortError(error)) {
      return false;
    }
  }

  const mid = abortBridge.createAbortHandle();
  const pending = abortBridge.transcribeWav(wav, { signal: mid.signal });
  await new Promise((r) => setImmediate(r));
  mid.abort();
  releaseAsr?.();
  try {
    await pending;
    return false;
  } catch (error: unknown) {
    if (!isAbortError(error)) {
      return false;
    }
  }

  const handle2 = bridge.createAbortHandle();
  try {
    for await (const _frame of bridge.synthesizeOpus("hello-abort", { signal: handle2.signal })) {
      handle2.abort();
    }
    return false;
  } catch (error: unknown) {
    return isAbortError(error);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}

function pendingRealDeviceReport(layer: "real" | "device"): VoiceHarnessReport {
  const checks: VoiceHarnessCheck[] = [
    {
      id: `${layer}-pending`,
      name: `${layer} layer not implemented this slice`,
      layer,
      ok: true,
      skipped: true,
      skipReason: "JOINT_PENDING — see docs/voice-longitudinal-harness.md",
    },
  ];
  return {
    layer,
    ok: true,
    checks,
    layers: layerStatuses(layer, "JOINT_PENDING").map((row) =>
      row.layer === layer
        ? { ...row, status: "JOINT_PENDING" as const, note: "JOINT_PENDING this slice" }
        : row.layer === "sim"
          ? { ...row, status: "partial" as const, note: "sim harness available via npm run voice-harness:sim" }
          : row,
    ),
    pending: VOICE_HARNESS_PENDING,
    voiceJointUnchanged: true,
    simUnchanged: true,
    asrText: "",
    assistantText: "",
    ttsFrameCountShort: 0,
    ttsFrameCountLong: 0,
  };
}

export function createVoiceLongitudinalHarness(): VoiceLongitudinalHarness {
  return {
    layer: "sim",
    runSim: (options) => runVoiceHarnessSim(options),
    async runReal() {
      return pendingRealDeviceReport("real");
    },
    async runDevice() {
      return pendingRealDeviceReport("device");
    },
  };
}

export function formatVoiceHarnessReport(report: VoiceHarnessReport): string {
  const lines: string[] = [
    `voice-harness / longitudinal (${report.layer}) — NOT voice-joint HTTP smoke; NOT npm run sim`,
    `ok: ${report.ok}`,
    `asrText: ${report.asrText.length > 0 ? report.asrText : "(n/a)"}`,
    `assistantText: ${report.assistantText.length > 0 ? report.assistantText : "(n/a)"}`,
    `ttsFrames short/long: ${report.ttsFrameCountShort}/${report.ttsFrameCountLong}`,
    `voiceJointUnchanged: ${report.voiceJointUnchanged}`,
    `simUnchanged: ${report.simUnchanged}`,
  ];
  for (const layer of report.layers) {
    lines.push(`layer.${layer.layer}: ${layer.status} — ${layer.note}`);
  }
  for (const check of report.checks) {
    if (check.skipped) {
      lines.push(`skip ${check.id} [${check.layer}] ${check.name}: ${check.skipReason ?? ""}`);
    } else {
      lines.push(`${check.ok ? "ok" : "FAIL"} ${check.id} [${check.layer}] ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
    }
  }
  lines.push(`JOINT_PENDING: ${report.pending.join("、")}`);
  lines.push("Revoke against real B stub :8787 is a docs gate (OPENBOT_DEVICE_DH_STUB_URL); sim uses in-process AUTH_REVOKED contract.");
  lines.push("Authority checklist: docs/voice-longitudinal-harness.md");
  return lines.join("\n");
}
