import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  MetalioAbortResidual,
  METALIO_DOWNLINK_SAMPLE_RATE,
  PROTOCOL_VERSION_DEFAULT,
  SERVER_FRAME_DURATION_DEFAULT_MS,
  UPLINK_CHANNELS,
  UPLINK_SAMPLE_RATE,
  OPUS_FRAME_DURATION_MS,
  DECODE_QUEUE_BUDGET_MS,
  decodeBinaryFrame,
  type AbortDecodePolicy,
} from "../../adapters/metalio/src/index.ts";
import {
  MockAsrProvider,
  MockTtsProvider,
  UndecodableUplinkError,
  finalTranscriptFromStream,
  isWavBuffer,
  mockAsrTranscript,
  packetsToAsrStreamChunks,
  resolveAsrAudio,
  uplinkPacketsLookLikeOpus,
  type AsrProvider,
  type AsrTranscribeOptions,
  type AsrUplinkCodec,
  type TtsProvider,
} from "../../adapters/voice/src/index.ts";

export { mockAsrTranscript };
import { SessionBook } from "../../integrations/openbot-b2/src/index.ts";
import {
  liveDialogueMode,
  liveTurnInputFromEnv,
  runLiveTurn,
  type AssistantSpeech,
  type LiveRunHandle,
} from "../../integrations/openbot-longitudinal/src/index.ts";
import { ControlPlane } from "./control-plane.ts";
import { WsFrameDecoder, encodeServerFrame, takeSocket, websocketAccept } from "./voice-ws.ts";

export interface LabAbortReport {
  residualMs: number;
  clearedUnsent: number;
  /** True when abortDecodePolicy is clear-on-abort (real TtsProvider path). */
  queueCleared: boolean;
  abortDecodePolicy: AbortDecodePolicy;
}

/**
 * Resolve abort decode policy for lab voice.
 * Real (non-mock) TtsProvider → clear-on-abort (product deviation).
 * Mock / placeholder → metalio-faithful residual ≤2400 ms.
 */
export function resolveAbortDecodePolicy(
  ttsProvider: TtsProvider,
  override?: AbortDecodePolicy,
): AbortDecodePolicy {
  if (override !== undefined) {
    return override;
  }
  return ttsProvider instanceof MockTtsProvider ? "metalio-faithful" : "clear-on-abort";
}

/**
 * Server play queue for the lab voice stub.
 *
 * metalio-faithful (default / mock): frames already handed to the device stay in
 * the 2400 ms residual model; abort does not ResetDecoder.
 * clear-on-abort (real TtsProvider): AbortSpeaking clears the decode queue
 * (lab model of ResetDecoder); queueCleared=true, residualMs=0.
 */
export class LabPlayQueue {
  private readonly residual: MetalioAbortResidual;
  private unsent = 0;
  readonly abortDecodePolicy: AbortDecodePolicy;

  constructor(abortDecodePolicy: AbortDecodePolicy = "metalio-faithful") {
    this.abortDecodePolicy = abortDecodePolicy;
    this.residual = new MetalioAbortResidual({ abortDecodePolicy });
  }

  start(): void {
    this.unsent = 0;
    this.residual.ttsStart();
  }

  /** A frame that has reached the device decoder queue. */
  sent(payload: Uint8Array): "queued" | "dropped" | "blocked" {
    return this.residual.enqueueDownlink(payload);
  }

  abort(sessionId: string): LabAbortReport {
    this.residual.abortSpeaking(sessionId);
    const clearedUnsent = this.unsent;
    this.unsent = 0;
    const queueCleared = this.abortDecodePolicy === "clear-on-abort";
    return {
      residualMs: this.residual.residualMs(),
      clearedUnsent,
      queueCleared,
      abortDecodePolicy: this.abortDecodePolicy,
    };
  }

  residualMs(): number {
    return this.residual.residualMs();
  }
}

export interface LabVoiceServerOptions {
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Injected ASR; default MockAsrProvider preserves lab-transcript / listen / ASR: hints. */
  asrProvider?: AsrProvider;
  /** Injected TTS; default MockTtsProvider yields OB-OPUS-PLACEHOLDER frames. */
  ttsProvider?: TtsProvider;
  /**
   * Abort decode policy. Default: metalio-faithful for MockTtsProvider,
   * clear-on-abort for any other (real) TtsProvider.
   */
  abortDecodePolicy?: AbortDecodePolicy;
  /**
   * Downlink rate written into the server hello and passed to TTS.
   * Default is the Claw4 speaker rate (16000). 24000 is accepted only when
   * a caller explicitly opts into the firmware's omitted-field fallback.
   */
  downlinkSampleRate?: 16000 | 24000;
  /** Clock for the local session book (tests expire the cursor without expiring the token). */
  now?: () => number;
}

export interface LabVoiceServer {
  url: string;
  port: number;
  book: SessionBook;
  close: () => Promise<void>;
}

export function startLabVoiceServer(
  plane: ControlPlane,
  options: LabVoiceServerOptions = {},
): Promise<LabVoiceServer> {
  const host = options.host ?? "127.0.0.1";
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const asrProvider = options.asrProvider ?? new MockAsrProvider();
  const ttsProvider = options.ttsProvider ?? new MockTtsProvider();
  const abortDecodePolicy = resolveAbortDecodePolicy(ttsProvider, options.abortDecodePolicy);
  const downlinkSampleRate = options.downlinkSampleRate ?? METALIO_DOWNLINK_SAMPLE_RATE;
  if (downlinkSampleRate !== 16000 && downlinkSampleRate !== 24000) {
    return Promise.reject(new Error("lab downlink sample rate must be 16000 or 24000"));
  }
  const book = new SessionBook({
    plane,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    takeSocket(socket);
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    acceptVoiceUpgrade(
      plane,
      book,
      req,
      socket,
      env,
      fetchImpl,
      asrProvider,
      ttsProvider,
      abortDecodePolicy,
      downlinkSampleRate,
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("lab voice server has no port"));
        return;
      }
      const advertisedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      resolve({
        url: `ws://${advertisedHost}:${address.port}`,
        port: address.port,
        book,
        close: () => closeVoice(server, sockets),
      });
    });
  });
}

function acceptVoiceUpgrade(
  plane: ControlPlane,
  book: SessionBook,
  req: IncomingMessage,
  socket: Duplex,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  asrProvider: AsrProvider,
  ttsProvider: TtsProvider,
  abortDecodePolicy: AbortDecodePolicy,
  downlinkSampleRate: 16000 | 24000,
): void {
  const deviceId = headerValue(req, "device-id");
  const clientId = headerValue(req, "client-id");
  const versionHeader = headerValue(req, "protocol-version") ?? String(PROTOCOL_VERSION_DEFAULT);
  const key = headerValue(req, "sec-websocket-key");
  const version = Number(versionHeader);
  if (!deviceId || !clientId || !key || !Number.isInteger(version) || version < 1) {
    rejectUpgrade(socket, 400, "Bad Request");
    return;
  }
  const token = bearer(headerValue(req, "authorization"));
  const decision = plane.assessConnectionCredential(deviceId, token);
  if (!decision.ok || token === undefined) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      "",
      "",
    ].join("\r\n"),
  );
  attachVoiceSession(
    plane,
    book,
    socket,
    deviceId,
    version,
    token,
    env,
    fetchImpl,
    asrProvider,
    ttsProvider,
    abortDecodePolicy,
    downlinkSampleRate,
  );
}

function attachVoiceSession(
  plane: ControlPlane,
  book: SessionBook,
  socket: Duplex,
  deviceId: string,
  version: number,
  token: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  asrProvider: AsrProvider,
  ttsProvider: TtsProvider,
  abortDecodePolicy: AbortDecodePolicy,
  downlinkSampleRate: 16000 | 24000,
): void {
  const decoder = new WsFrameDecoder();
  const play = new LabPlayQueue(abortDecodePolicy);
  let sessionId = "";
  let greeted = false;
  let listening = false;
  let listenText = "";
  let binaryNote = "";
  /** Whole-utterance PCM/WAV uplink collected during listen (A3). */
  const audioChunks: Buffer[] = [];
  let uplinkBytes = 0;
  let uplinkTruncated = false;
  let aborted = false;
  let speaking = false;
  let turn = 0;
  let closed = false;
  let activeRun: LiveRunHandle | undefined;
  const speechQueue: AssistantSpeech[] = [];
  let drainingSpeech = false;
  let finishing = false;
  let finishGeneration = 0;
  let inFlightBytes = 0;

  const sendText = (body: unknown): void => {
    if (closed || socket.destroyed || !socket.writable || socket.writableEnded) {
      return;
    }
    try {
      const payload = Buffer.from(JSON.stringify(body));
      if (payload.length > 60_000) {
        voiceDiag({ event: "send.skipped", sessionId, deviceId, detail: "json frame exceeds 60000 bytes" });
        return;
      }
      socket.write(encodeServerFrame(1, payload));
    } catch (error) {
      voiceDiag({ event: "send.failed", sessionId, deviceId, detail: safeDetail(error) });
    }
  };
  const sendBinary = (payload: Buffer): void => {
    if (closed || socket.destroyed || !socket.writable || socket.writableEnded) {
      return;
    }
    try {
      socket.write(encodeServerFrame(2, payload));
    } catch (error) {
      voiceDiag({ event: "send.failed", sessionId, deviceId, detail: safeDetail(error) });
    }
  };

  socket.on("error", (error: Error) => {
    // A missing error listener is an uncaught exception: Node exits and RSTs the device TLS session.
    voiceDiag({ event: "socket.error", sessionId, deviceId, detail: safeDetail(error) });
    closed = true;
  });

  socket.on("data", (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      // Unrecoverable framing only. listen.stop audio is a normal masked frame and must not land here.
      voiceDiag({ event: "ws_frame", sessionId, deviceId, detail: safeDetail(error) });
      closed = true;
      try {
        socket.end(encodeServerFrame(8, Buffer.alloc(0)));
      } catch {
        socket.destroy();
      }
      return;
    }
    try {
      for (const frame of frames) {
        if (frame.opcode === 8) {
          closed = true;
          socket.end(encodeServerFrame(8, Buffer.alloc(0)));
          return;
        }
        if (frame.opcode === 9) {
          sendBinaryPong(frame.payload);
          continue;
        }
        if (frame.opcode === 1) {
          handleText(frame.payload.toString("utf8"));
          continue;
        }
        if (frame.opcode === 2 && listening) {
          if (refuseIfCredentialDead()) {
            return;
          }
          const payload = rawUplinkPacket(version, Buffer.from(frame.payload));
          const asText = payload.toString("utf8");
          if (asText.startsWith("ASR:")) {
            binaryNote = asText;
          } else {
            pushUplink(payload);
          }
        }
      }
    } catch (error) {
      voiceDiag({ event: "socket.data", sessionId, deviceId, detail: safeDetail(error) });
    }
  });

  function sendBinaryPong(payload: Buffer): void {
    if (closed || socket.destroyed || !socket.writable || socket.writableEnded) {
      return;
    }
    try {
      socket.write(encodeServerFrame(10, payload));
    } catch (error) {
      voiceDiag({ event: "send.failed", sessionId, deviceId, detail: safeDetail(error) });
    }
  }

  function pushUplink(payload: Buffer): void {
    if (uplinkTruncated) {
      return;
    }
    if (audioChunks.length >= MAX_UPLINK_PACKETS || uplinkBytes + payload.byteLength > MAX_UPLINK_BYTES) {
      uplinkTruncated = true;
      voiceDiag({
        event: "uplink.truncated",
        sessionId,
        deviceId,
        packets: audioChunks.length,
        bytes: uplinkBytes,
      });
      return;
    }
    audioChunks.push(payload);
    uplinkBytes += payload.byteLength;
  }

  function refuseIfCredentialDead(): boolean {
    if (closed) {
      return true;
    }
    let decision;
    try {
      decision = plane.assessConnectionCredential(deviceId, token);
    } catch (error) {
      // A store reload failure must not RST the device. Keep the socket and report it.
      voiceDiag({ event: "credential.check_failed", sessionId, deviceId, detail: safeDetail(error) });
      return true;
    }
    if (decision.ok) {
      return false;
    }
    voiceDiag({ event: "credential.rejected", sessionId, deviceId, code: decision.code });
    speaking = false;
    aborted = true;
    closed = true;
    try {
      socket.end(encodeServerFrame(8, Buffer.alloc(0)));
    } catch {
      socket.destroy();
    }
    return true;
  }

  function handleText(raw: string): void {
    if (refuseIfCredentialDead()) {
      return;
    }
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (!greeted) {
      if (!isClientHello(message, version)) {
        closed = true;
        socket.end();
        return;
      }
      const binding = plane.getBinding(deviceId);
      if (!binding) {
        closed = true;
        socket.end();
        return;
      }
      let opened;
      try {
        opened = book.open({
          authorizationRef: binding.authorizationRef,
          bindingVersion: binding.bindingVersion,
          digitalHumanId: binding.digitalHumanId,
          deviceId,
          idempotencyKey: `voice-${deviceId}`,
        });
      } catch (error) {
        // SESSION_BUSY and similar used to throw out of the data handler and kill the process (TCP RST).
        voiceDiag({ event: "hello.failed", deviceId, detail: safeDetail(error) });
        return;
      }
      sessionId = opened.sessionId;
      greeted = true;
      sendText({
        type: "hello",
        transport: "websocket",
        session_id: sessionId,
        version,
        audio_params: {
          format: "opus",
          sample_rate: downlinkSampleRate,
          channels: UPLINK_CHANNELS,
          frame_duration: SERVER_FRAME_DURATION_DEFAULT_MS,
        },
      });
      voiceDiag({
        event: "hello",
        sessionId,
        deviceId,
        downlinkSampleRate,
        protocolVersion: version,
      });
      return;
    }
    if (message.type === "abort") {
      stopSpeaking(typeof message.reason === "string" ? message.reason : undefined);
      return;
    }
    if (message.type !== "listen" || typeof message.state !== "string") {
      return;
    }
    if (message.state === "start") {
      if (finishing && inFlightBytes === 0) {
        cancelFinish("listen.start");
      }
      listening = true;
      listenText = "";
      binaryNote = "";
      audioChunks.length = 0;
      uplinkBytes = 0;
      uplinkTruncated = false;
      voiceDiag({ event: "listen.start", sessionId, deviceId });
      return;
    }
    if (message.state === "detect" && typeof message.text === "string") {
      listenText = message.text;
      voiceDiag({ event: "listen.detect", sessionId, deviceId, textChars: message.text.length });
      return;
    }
    if (message.state === "stop") {
      if (typeof message.text === "string" && message.text.length > 0) {
        listenText = message.text;
      }
      scheduleFinish();
    }
  }

  function cancelFinish(reason: string): void {
    finishGeneration += 1;
    finishing = false;
    inFlightBytes = 0;
    voiceDiag({ event: "listen.finish.cancelled", sessionId, deviceId, reason });
  }

  function scheduleFinish(): void {
    if (finishing) {
      if (inFlightBytes === 0) {
        cancelFinish("empty in-flight superseded by stop");
      } else {
        voiceDiag({ event: "listen.stop.ignored", sessionId, deviceId, detail: "turn already finishing" });
        return;
      }
    }
    finishing = true;
    const generation = finishGeneration + 1;
    finishGeneration = generation;
    listening = false;
    const hint = listenText.length > 0 ? listenText : binaryNote;
    const packets = audioChunks.map((chunk) => Buffer.from(chunk));
    const stats = summarizeUplink(packets, uplinkTruncated);
    inFlightBytes = stats.bytes;
    listenText = "";
    binaryNote = "";
    audioChunks.length = 0;
    uplinkBytes = 0;
    uplinkTruncated = false;
    voiceDiag({
      event: "listen.finish.start",
      sessionId,
      deviceId,
      ...stats,
      hintChars: hint.length,
    });
    void finishUtterance(generation, packets, stats, hint)
      .catch((error: unknown) => {
        if (generation !== finishGeneration) {
          return;
        }
        voiceDiag({ event: "turn.failed", sessionId, deviceId, ...stats, detail: safeDetail(error) });
        speakPrompt(USER_PROMPT_UNAVAILABLE);
      })
      .finally(() => {
        if (generation === finishGeneration) {
          finishing = false;
        }
      });
  }

  function isBlankTranscript(value: string): boolean {
    return value.trim().length === 0;
  }

  function speakPrompt(text: string): void {
    void beginTts(text, "openbot", undefined, true).catch((error: unknown) => {
      voiceDiag({ event: "prompt.failed", sessionId, deviceId, detail: safeDetail(error) });
    });
  }

  /**
   * Runs injected AsrProvider (default mock).
   * - Whole-utterance WAV -> `transcribe` via resolveAsrAudio.
   * - Packetized uplink (Opus or PCM frames) -> `asrProvider.stream()` with preserved
   *   packet boundaries; Opus chunks are labeled codec:"opus" (never PCM).
   * - Otherwise listen text / `ASR:` notes (lab hints) via transcribe or stream.
   * listen.detect only stores a hint; ASR runs on listen.stop.
   * Empty transcripts never go to the OpenBot turns API. User-visible failures
   * are spoken with tts sentence_start, never type:error.
   */
  async function finishUtterance(
    generation: number,
    packets: Buffer[],
    stats: UplinkStats,
    hint: string,
  ): Promise<void> {
    if (generation !== finishGeneration) {
      return;
    }
    if (refuseIfCredentialDead()) {
      return;
    }
    let text: string;
    try {
      text = await resolveLabUtteranceTranscript(asrProvider, packets, hint);
    } catch (error) {
      if (generation !== finishGeneration) {
        return;
      }
      const incomplete = isUplinkIncomplete(error);
      const code = incomplete ? "uplink_incomplete" : "asr_failed";
      voiceDiag({
        event: "listen.stop",
        sessionId,
        deviceId,
        ...stats,
        result: code,
        detail: safeDetail(error),
      });
      sendText({ type: "stt", session_id: sessionId, text: "", source: "asr", dialogue: "off" });
      speakPrompt(USER_PROMPT_NOT_HEARD);
      return;
    }
    if (generation !== finishGeneration) {
      return;
    }
    if (refuseIfCredentialDead()) {
      return;
    }
    turn += 1;
    const turnIndex = turn;
    try {
      book.append(sessionId, { eventId: `turn-${turnIndex}`, type: "user.turn" });
    } catch (error) {
      voiceDiag({
        event: "turn.append_failed",
        sessionId,
        deviceId,
        ...stats,
        detail: safeDetail(error),
      });
    }
    voiceDiag({
      event: "listen.stop",
      sessionId,
      deviceId,
      ...stats,
      result: "stt",
      textChars: text.length,
    });
    let mode: "sim" | "live" | "off";
    try {
      mode = liveDialogueMode(env);
    } catch (error) {
      sendText({ type: "stt", session_id: sessionId, text, source: "sim-asr", dialogue: "sim" });
      reportLiveFailure(error);
      return;
    }
    if (mode === "off") {
      sendText({ type: "stt", session_id: sessionId, text, source: "sim-asr", dialogue: "off" });
      speakPrompt(isBlankTranscript(text) ? USER_PROMPT_NOT_HEARD : USER_PROMPT_UNAVAILABLE);
      return;
    }
    if (mode === "sim") {
      sendText({ type: "stt", session_id: sessionId, text, source: "sim", dialogue: "sim" });
      if (isBlankTranscript(text)) {
        speakPrompt(USER_PROMPT_NOT_HEARD);
        return;
      }
      void beginTts(text, "sim").catch((error: unknown) => {
        reportLiveFailure(error);
      });
      return;
    }
    sendText({ type: "stt", session_id: sessionId, text, source: "sim-asr", dialogue: "sim" });
    if (isBlankTranscript(text)) {
      voiceDiag({ event: "asr.empty", sessionId, deviceId, ...stats, textChars: 0 });
      speakPrompt(USER_PROMPT_NOT_HEARD);
      return;
    }
    void speakFromOpenBot(text, turnIndex);
  }

  function speakFromOpenBot(text: string, turnIndex: number): void {
    let input;
    try {
      const binding = plane.getBinding(deviceId);
      input = liveTurnInputFromEnv(env, {
        deviceId,
        digitalHumanId: binding?.digitalHumanId ?? "",
        text,
        turnId: `turn-${turnIndex}`,
        idempotencyKey: `voice-${deviceId}-${sessionId}-${turnIndex}`,
      });
    } catch (error) {
      reportLiveFailure(error);
      return;
    }
    void runLiveTurn(input, {
      env,
      fetchImpl,
      onRun: (run) => {
        activeRun = run;
        if (aborted || closed) {
          void run.cancel().catch((error: unknown) => {
            reportLiveFailure(error);
          });
        }
      },
      onSpeech: (speech) => {
        if (aborted || closed) {
          return;
        }
        speechQueue.push(speech);
        drainSpeech();
      },
    }).catch((error: unknown) => {
      reportLiveFailure(error);
    });
  }

  function drainSpeech(): void {
    if (drainingSpeech || aborted || closed) {
      return;
    }
    const next = speechQueue.shift();
    if (next === undefined) {
      return;
    }
    drainingSpeech = true;
    void beginTts(next.text, "openbot", () => {
      drainingSpeech = false;
      drainSpeech();
    }).catch((error: unknown) => {
      drainingSpeech = false;
      reportLiveFailure(error);
    });
  }

  function reportLiveFailure(error: unknown): void {
    if (closed) {
      return;
    }
    const detail = safeDetail(error);
    voiceDiag({ event: "live.failed", sessionId, deviceId, detail });
    speakPrompt(USER_PROMPT_UNAVAILABLE);
  }

  async function beginTts(
    text: string,
    source: "sim" | "openbot",
    onDone?: () => void,
    isPrompt = false,
  ): Promise<void> {
    aborted = false;
    speaking = true;
    play.start();
    const dialogue = source === "sim" ? "sim" : "openbot";
    sendText({ type: "tts", state: "start", session_id: sessionId, text, source, dialogue });
    sendText({ type: "tts", state: "sentence_start", session_id: sessionId, text, source, dialogue });
    const finish = () => {
      onDone?.();
    };
    try {
      for await (const payload of ttsProvider.synthesize(text, { sampleRate: downlinkSampleRate })) {
        if (refuseIfCredentialDead()) {
          speaking = false;
          finish();
          return;
        }
        if (!speaking || aborted) {
          finish();
          return;
        }
        const queued = play.sent(payload);
        if (queued !== "queued") {
          speaking = false;
          finish();
          return;
        }
        sendBinary(payload);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      if (speaking && !aborted) {
        if (refuseIfCredentialDead()) {
          speaking = false;
          finish();
          return;
        }
        sendText({ type: "tts", state: "stop", session_id: sessionId, source, dialogue });
        speaking = false;
      }
      finish();
    } catch (error) {
      speaking = false;
      voiceDiag({ event: "tts.failed", sessionId, deviceId, detail: safeDetail(error) });
      if (!isPrompt) {
        speakPrompt(USER_PROMPT_UNAVAILABLE);
      }
      finish();
    }
  }

  function stopSpeaking(reason: string | undefined): void {
    if (!greeted) {
      return;
    }
    aborted = true;
    speaking = false;
    speechQueue.length = 0;
    const run = activeRun;
    activeRun = undefined;
    if (run !== undefined) {
      void run.cancel().catch((error: unknown) => {
        reportLiveFailure(error);
      });
    }
    const report = play.abort(sessionId);
    sendText({
      type: "lab.abort",
      session_id: sessionId,
      reason: reason ?? null,
      residualMs: report.residualMs,
      residualCapMs: DECODE_QUEUE_BUDGET_MS,
      frameMs: OPUS_FRAME_DURATION_MS,
      queueCleared: report.queueCleared,
      abortDecodePolicy: report.abortDecodePolicy,
    });
  }
}

/** ~3 minutes of 60 ms uplink frames, or 1.5 MB, whichever comes first. */
const MAX_UPLINK_PACKETS = 3_000;
const MAX_UPLINK_BYTES = 1_500_000;
/** Device-facing Xiaozhi prompts. Never send type:error; use tts sentence_start instead. */
const USER_PROMPT_NOT_HEARD = "没有听清，请再说一遍";
const USER_PROMPT_UNAVAILABLE = "暂时无法回答，请稍后再试";

const SECRET_TEXT = /Bearer\s+\S+|ctok_[A-Za-z0-9_-]+|azr_[A-Za-z0-9_-]+|grant[_-][A-Za-z0-9_.:-]{8,}/gi;

interface UplinkStats {
  packets: number;
  bytes: number;
  emptyPackets: number;
  approxDurationMs: number;
  truncated: boolean;
}

function summarizeUplink(packets: readonly Buffer[], truncated: boolean): UplinkStats {
  let bytes = 0;
  let emptyPackets = 0;
  for (const packet of packets) {
    bytes += packet.byteLength;
    if (packet.byteLength === 0) {
      emptyPackets += 1;
    }
  }
  const voiced = packets.length - emptyPackets;
  return {
    packets: packets.length,
    bytes,
    emptyPackets,
    // One Metalio uplink frame is 60 ms. AFE overflow can make this shorter than wall-clock speech.
    approxDurationMs: voiced * OPUS_FRAME_DURATION_MS,
    truncated,
  };
}

function publicUplink(stats: UplinkStats): Record<string, number | boolean> {
  return {
    packets: stats.packets,
    bytes: stats.bytes,
    emptyPackets: stats.emptyPackets,
    approxDurationMs: stats.approxDurationMs,
    truncated: stats.truncated,
  };
}

function safeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(SECRET_TEXT, "[redacted]").slice(0, 240);
}

function voiceDiag(fields: Record<string, unknown>): void {
  const payload: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (key === "token" || key === "authorization" || key === "grant") {
      continue;
    }
    payload[key] = value;
  }
  process.stderr.write(`VOICE-DIAG ${JSON.stringify(payload)}\n`);
}

function isUplinkIncomplete(error: unknown): boolean {
  return error instanceof UndecodableUplinkError || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "uplink_incomplete");
}

/** Protocol version 2/3 prefixes a header; version 1 is the bare Opus body. */
function rawUplinkPacket(version: number, payload: Buffer): Buffer {
  if (version !== 2 && version !== 3) {
    return payload;
  }
  try {
    return Buffer.from(decodeBinaryFrame(version, payload).payload);
  } catch {
    return payload;
  }
}

function isClientHello(message: Record<string, unknown>, version: number): boolean {
  if (message.type !== "hello" || message.transport !== "websocket" || message.version !== version) {
    return false;
  }
  const features = message.features;
  if (typeof features !== "object" || features === null || (features as { mcp?: unknown }).mcp !== true) {
    return false;
  }
  const audio = message.audio_params;
  if (typeof audio !== "object" || audio === null) {
    return false;
  }
  const params = audio as Record<string, unknown>;
  return (
    params.format === "opus" &&
    params.sample_rate === UPLINK_SAMPLE_RATE &&
    params.channels === UPLINK_CHANNELS &&
    params.frame_duration === OPUS_FRAME_DURATION_MS
  );
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bearer(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function closeVoice(server: Server, sockets: Set<Duplex>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}


/**
 * Lab ASR entry for one listen utterance (P1-2).
 * WAV whole-file -> transcribe. Otherwise, when `asrProvider.stream` exists, call stream()
 * with per-packet AsrStreamChunk (codec opus when packets look like Opus; never label Opus as PCM).
 */
async function resolveLabUtteranceTranscript(
  asrProvider: AsrProvider,
  packets: Buffer[],
  hint: string,
): Promise<string> {
  const captured = packets.length > 0 ? Buffer.concat(packets) : Buffer.alloc(0);

  if (captured.byteLength > 0 && isWavBuffer(captured)) {
    const resolved = resolveAsrAudio(captured, {
      sampleRate: UPLINK_SAMPLE_RATE,
      channels: UPLINK_CHANNELS,
    });
    return asrProvider.transcribe(resolved.audio, resolved.options);
  }

  if (typeof asrProvider.stream === "function") {
    let codec: AsrUplinkCodec = "pcm";
    let streamPackets: Buffer[] = packets;
    if (packets.length > 0) {
      codec = uplinkPacketsLookLikeOpus(packets) ? "opus" : "pcm";
    } else {
      streamPackets = [Buffer.from(hint, "utf8")];
      codec = "pcm";
    }
    const chunks = packetsToAsrStreamChunks(streamPackets, {
      sampleRate: UPLINK_SAMPLE_RATE,
      channels: UPLINK_CHANNELS,
      codec,
    });
    return finalTranscriptFromStream(asrProvider, chunks);
  }

  // Fallback when Provider has no stream(): whole-utterance transcribe.
  let audio: Buffer;
  let options: AsrTranscribeOptions;
  if (captured.byteLength > 0) {
    const resolved = resolveAsrAudio(captured, {
      sampleRate: UPLINK_SAMPLE_RATE,
      channels: UPLINK_CHANNELS,
    });
    audio = resolved.audio;
    options = resolved.options;
  } else {
    audio = Buffer.from(hint, "utf8");
    options = {
      sampleRate: UPLINK_SAMPLE_RATE,
      channels: UPLINK_CHANNELS,
      format: "pcm",
    };
  }
  return asrProvider.transcribe(audio, options);
}
