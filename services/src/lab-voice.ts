import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  MetalioAbortResidual,
  OPUS_PLACEHOLDER_MAGIC,
  PROTOCOL_VERSION_DEFAULT,
  SERVER_FRAME_DURATION_DEFAULT_MS,
  SERVER_SAMPLE_RATE_DEFAULT,
  UPLINK_CHANNELS,
  UPLINK_SAMPLE_RATE,
  OPUS_FRAME_DURATION_MS,
  DECODE_QUEUE_BUDGET_MS,
} from "../../adapters/metalio/src/index.ts";
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

const TTS_FRAME_COUNT = 8;

export interface LabAbortReport {
  residualMs: number;
  clearedUnsent: number;
  queueCleared: false;
}

/**
 * Server play queue for the lab voice stub.
 * Frames already handed to the device stay in the 2400 ms residual model.
 * Abort stops further sends and does not call ResetDecoder.
 */
export class LabPlayQueue {
  private readonly residual = new MetalioAbortResidual();
  private unsent = 0;

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
    return { residualMs: this.residual.residualMs(), clearedUnsent, queueCleared: false };
  }

  residualMs(): number {
    return this.residual.residualMs();
  }
}

export function mockAsrTranscript(input: { listenText?: string; binaryNote?: string }): string {
  if (input.listenText !== undefined && input.listenText.length > 0) {
    return input.listenText;
  }
  if (input.binaryNote !== undefined && input.binaryNote.startsWith("ASR:")) {
    return input.binaryNote.slice(4);
  }
  return "lab-transcript";
}

export interface LabVoiceServer {
  url: string;
  port: number;
  book: SessionBook;
  close: () => Promise<void>;
}

export function startLabVoiceServer(
  plane: ControlPlane,
  options: { host?: string; port?: number; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<LabVoiceServer> {
  const host = options.host ?? "127.0.0.1";
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const book = new SessionBook({ plane });
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    takeSocket(socket);
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    acceptVoiceUpgrade(plane, book, req, socket, env, fetchImpl);
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
  attachVoiceSession(plane, book, socket, deviceId, version, token, env, fetchImpl);
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
): void {
  const decoder = new WsFrameDecoder();
  const play = new LabPlayQueue();
  let sessionId = "";
  let greeted = false;
  let listening = false;
  let listenText = "";
  let binaryNote = "";
  let aborted = false;
  let speaking = false;
  let turn = 0;
  let closed = false;
  let activeRun: LiveRunHandle | undefined;
  const speechQueue: AssistantSpeech[] = [];
  let drainingSpeech = false;

  const sendText = (body: unknown) => {
    socket.write(encodeServerFrame(1, Buffer.from(JSON.stringify(body))));
  };
  const sendBinary = (payload: Buffer) => {
    socket.write(encodeServerFrame(2, payload));
  };

  socket.on("data", (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      socket.end();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === 8) {
        socket.end(encodeServerFrame(8, Buffer.alloc(0)));
        return;
      }
      if (frame.opcode === 9) {
        socket.write(encodeServerFrame(10, frame.payload));
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
        const text = frame.payload.toString("utf8");
        if (text.startsWith("ASR:")) {
          binaryNote = text;
        }
      }
    }
  });

  function refuseIfCredentialDead(): boolean {
    if (closed) {
      return true;
    }
    const decision = plane.assessConnectionCredential(deviceId, token);
    if (decision.ok) {
      return false;
    }
    closed = true;
    speaking = false;
    aborted = true;
    sendText({ type: "error", code: decision.code });
    socket.end();
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
        sendText({ type: "error", code: "hello" });
        socket.end();
        return;
      }
      const binding = plane.getBinding(deviceId);
      if (!binding) {
        sendText({ type: "error", code: "unbound" });
        socket.end();
        return;
      }
      const opened = book.open({
        authorizationRef: binding.authorizationRef,
        bindingVersion: binding.bindingVersion,
        digitalHumanId: binding.digitalHumanId,
        deviceId,
        idempotencyKey: `voice-${deviceId}`,
      });
      sessionId = opened.sessionId;
      greeted = true;
      sendText({
        type: "hello",
        transport: "websocket",
        session_id: sessionId,
        version,
        audio_params: {
          format: "opus",
          sample_rate: SERVER_SAMPLE_RATE_DEFAULT,
          channels: UPLINK_CHANNELS,
          frame_duration: SERVER_FRAME_DURATION_DEFAULT_MS,
        },
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
      listening = true;
      listenText = "";
      binaryNote = "";
      return;
    }
    if (message.state === "detect" && typeof message.text === "string") {
      listenText = message.text;
      finishUtterance();
      return;
    }
    if (message.state === "stop") {
      if (typeof message.text === "string" && message.text.length > 0) {
        listenText = message.text;
      }
      finishUtterance();
    }
  }

  /**
   * Local mock ASR. With no live stub this also speaks that transcript and is labeled `sim`.
   * A configured stub speaks only `assistant.visible` / `assistant.final`. It does not
   * turn the ASR text into OpenBot dialogue.
   */
  function finishUtterance(): void {
    if (refuseIfCredentialDead()) {
      return;
    }
    listening = false;
    const text = mockAsrTranscript({ listenText, binaryNote });
    listenText = "";
    binaryNote = "";
    turn += 1;
    const turnIndex = turn;
    book.append(sessionId, { eventId: `turn-${turnIndex}`, type: "user.turn" });
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
      sendText({
        type: "error",
        code: "dialogue_unavailable",
        source: "off",
        dialogue: "off",
        detail: "OPENBOT_DEVICE_DH_TEST_MODE=1 is required for local sim; the live connector is not configured",
      });
      return;
    }
    if (mode === "sim") {
      sendText({ type: "stt", session_id: sessionId, text, source: "sim", dialogue: "sim" });
      beginTts(text, "sim");
      return;
    }
    sendText({ type: "stt", session_id: sessionId, text, source: "sim-asr", dialogue: "sim" });
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
    beginTts(next.text, "openbot", () => {
      drainingSpeech = false;
      drainSpeech();
    });
  }

  function reportLiveFailure(error: unknown): void {
    if (closed) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    sendText({ type: "error", code: "live_stub", source: "openbot", dialogue: "openbot", detail });
  }

  function beginTts(text: string, source: "sim" | "openbot", onDone?: () => void): void {
    aborted = false;
    speaking = true;
    play.start();
    const dialogue = source === "sim" ? "sim" : "openbot";
    sendText({ type: "tts", state: "start", session_id: sessionId, text, source, dialogue });
    const payload = Buffer.from(OPUS_PLACEHOLDER_MAGIC);
    let index = 0;
    const finish = () => {
      onDone?.();
    };
    const step = () => {
      if (refuseIfCredentialDead()) {
        speaking = false;
        finish();
        return;
      }
      if (!speaking || aborted || index >= TTS_FRAME_COUNT) {
        if (speaking && !aborted) {
          sendText({ type: "tts", state: "stop", session_id: sessionId, source, dialogue });
          speaking = false;
        }
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
      index += 1;
      setImmediate(step);
    };
    setImmediate(step);
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
    });
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
