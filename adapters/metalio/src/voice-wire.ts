import {
  BINARY_PROTOCOL2_HEADER_BYTES,
  BINARY_PROTOCOL3_HEADER_BYTES,
  CHANNEL_IDLE_TIMEOUT_SECONDS,
  HELLO_TIMEOUT_MS,
  OPUS_FRAME_DURATION_MS,
  PROTOCOL_VERSION_DEFAULT,
  SERVER_FRAME_DURATION_DEFAULT_MS,
  SERVER_SAMPLE_RATE_DEFAULT,
  UPLINK_CHANNELS,
  UPLINK_SAMPLE_RATE,
} from "./constants.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class VoiceWireError extends Error {
  readonly code = "voice_wire";

  constructor(message: string) {
    super(message);
    this.name = "VoiceWireError";
  }
}

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new VoiceWireError("session_id must match [A-Za-z0-9_-]{1,128}; the firmware concatenates it without JSON escaping");
  }
}

export interface ClientHello {
  type: "hello";
  version: number;
  features: { mcp: true };
  transport: "websocket";
  audio_params: {
    format: "opus";
    sample_rate: typeof UPLINK_SAMPLE_RATE;
    channels: typeof UPLINK_CHANNELS;
    frame_duration: typeof OPUS_FRAME_DURATION_MS;
  };
}

/** Mirrors `WebsocketProtocol::GetHelloMessage` at the firmware baseline. */
export function buildClientHello(version: number = PROTOCOL_VERSION_DEFAULT): ClientHello {
  if (!Number.isInteger(version) || version < 1) {
    throw new VoiceWireError("protocol version must be a positive integer");
  }
  return {
    type: "hello",
    version,
    features: { mcp: true },
    transport: "websocket",
    audio_params: {
      format: "opus",
      sample_rate: UPLINK_SAMPLE_RATE,
      channels: UPLINK_CHANNELS,
      frame_duration: OPUS_FRAME_DURATION_MS,
    },
  };
}

export interface ServerHello {
  transport: "websocket";
  sessionId: string | null;
  sampleRate: number;
  frameDurationMs: number;
}

/**
 * Mirrors `WebsocketProtocol::ParseServerHello`.
 * A missing or non-websocket transport does not complete the handshake.
 */
export function parseServerHello(message: unknown): ServerHello {
  if (typeof message !== "object" || message === null) {
    throw new VoiceWireError("server hello is not an object");
  }
  const record = message as Record<string, unknown>;
  if (record.type !== "hello") {
    throw new VoiceWireError("server hello type must be hello");
  }
  if (record.transport !== "websocket") {
    throw new VoiceWireError("server hello transport must be websocket");
  }
  let sessionId: string | null = null;
  if (typeof record.session_id === "string") {
    assertSessionId(record.session_id);
    sessionId = record.session_id;
  }
  let sampleRate = SERVER_SAMPLE_RATE_DEFAULT;
  let frameDurationMs = SERVER_FRAME_DURATION_DEFAULT_MS;
  const audio = record.audio_params;
  if (typeof audio === "object" && audio !== null) {
    const params = audio as Record<string, unknown>;
    if (typeof params.sample_rate === "number" && Number.isFinite(params.sample_rate)) {
      sampleRate = params.sample_rate;
    }
    if (typeof params.frame_duration === "number" && Number.isFinite(params.frame_duration)) {
      frameDurationMs = params.frame_duration;
    }
  }
  return { transport: "websocket", sessionId, sampleRate, frameDurationMs };
}

export interface WebsocketHeaderInput {
  deviceId: string;
  clientId: string;
  token?: string;
  protocolVersion?: number;
}

/** Header names match `WebsocketProtocol::OpenAudioChannel`. */
export function buildWebsocketHeaders(input: WebsocketHeaderInput): Record<string, string> {
  if (input.deviceId.length === 0 || input.clientId.length === 0) {
    throw new VoiceWireError("Device-Id and Client-Id are required");
  }
  const headers: Record<string, string> = {
    "Protocol-Version": String(input.protocolVersion ?? PROTOCOL_VERSION_DEFAULT),
    "Device-Id": input.deviceId,
    "Client-Id": input.clientId,
  };
  if (input.token !== undefined && input.token.length > 0) {
    headers.Authorization = input.token.includes(" ") ? input.token : `Bearer ${input.token}`;
  }
  return headers;
}

export type AbortReason = "wake_word_detected";

/** Byte-compatible with `Protocol::SendAbortSpeaking` for a safe session id. */
export function buildAbortMessage(sessionId: string, reason?: AbortReason): string {
  assertSessionId(sessionId);
  let message = `{"session_id":"${sessionId}","type":"abort"`;
  if (reason === "wake_word_detected") {
    message += `,"reason":"wake_word_detected"`;
  }
  message += "}";
  return message;
}

export type ListeningMode = "auto" | "manual" | "realtime";

export function buildListenMessage(
  sessionId: string,
  state: "start" | "stop" | "detect",
  extra?: { mode?: ListeningMode; text?: string },
): string {
  assertSessionId(sessionId);
  if (state === "detect") {
    const text = extra?.text ?? "";
    if (!/^[\x20-\x7e]+$/.test(text) || text.includes('"') || text.includes("\\")) {
      throw new VoiceWireError("wake-word text must be printable ASCII without quotes");
    }
    return `{"session_id":"${sessionId}","type":"listen","state":"detect","text":"${text}"}`;
  }
  if (state === "stop") {
    return `{"session_id":"${sessionId}","type":"listen","state":"stop"}`;
  }
  const mode = extra?.mode ?? "auto";
  return `{"session_id":"${sessionId}","type":"listen","state":"start","mode":"${mode}"}`;
}

export function buildMcpMessage(sessionId: string, payload: unknown): string {
  assertSessionId(sessionId);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new VoiceWireError("mcp payload must be a JSON object");
  }
  return `{"session_id":"${sessionId}","type":"mcp","payload":${JSON.stringify(payload)}}`;
}

export interface BinaryFrame {
  version: number;
  payload: Uint8Array;
  timestamp: number;
}

/**
 * version 2 and 3 match `WebsocketProtocol::SendAudio` / the binary branch of `OnData`.
 * Any other version is the raw Opus body (firmware default `version_ = 1`).
 */
export function encodeBinaryFrame(frame: BinaryFrame): Buffer {
  const payload = Buffer.from(frame.payload);
  if (frame.version === 2) {
    if (!Number.isInteger(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > 0xffffffff) {
      throw new VoiceWireError("protocol 2 timestamp must fit in uint32");
    }
    const header = Buffer.alloc(BINARY_PROTOCOL2_HEADER_BYTES);
    header.writeUInt16BE(frame.version, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt32BE(0, 4);
    header.writeUInt32BE(frame.timestamp, 8);
    header.writeUInt32BE(payload.length, 12);
    return Buffer.concat([header, payload]);
  }
  if (frame.version === 3) {
    if (payload.length > 0xffff) {
      throw new VoiceWireError("protocol 3 payload exceeds uint16");
    }
    const header = Buffer.alloc(BINARY_PROTOCOL3_HEADER_BYTES);
    header.writeUInt8(0, 0);
    header.writeUInt8(0, 1);
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  return payload;
}

export function decodeBinaryFrame(version: number, data: Uint8Array): { payload: Uint8Array; timestamp: number } {
  const buffer = Buffer.from(data);
  if (version === 2) {
    if (buffer.length < BINARY_PROTOCOL2_HEADER_BYTES) {
      throw new VoiceWireError("short binary protocol 2 frame");
    }
    const payloadSize = buffer.readUInt32BE(12);
    if (buffer.length < BINARY_PROTOCOL2_HEADER_BYTES + payloadSize) {
      throw new VoiceWireError("truncated binary protocol 2 frame");
    }
    return {
      timestamp: buffer.readUInt32BE(8),
      payload: Uint8Array.from(buffer.subarray(BINARY_PROTOCOL2_HEADER_BYTES, BINARY_PROTOCOL2_HEADER_BYTES + payloadSize)),
    };
  }
  if (version === 3) {
    if (buffer.length < BINARY_PROTOCOL3_HEADER_BYTES) {
      throw new VoiceWireError("short binary protocol 3 frame");
    }
    const payloadSize = buffer.readUInt16BE(2);
    if (buffer.length < BINARY_PROTOCOL3_HEADER_BYTES + payloadSize) {
      throw new VoiceWireError("truncated binary protocol 3 frame");
    }
    return {
      timestamp: 0,
      payload: Uint8Array.from(buffer.subarray(BINARY_PROTOCOL3_HEADER_BYTES, BINARY_PROTOCOL3_HEADER_BYTES + payloadSize)),
    };
  }
  return { timestamp: 0, payload: Uint8Array.from(buffer) };
}

export const VOICE_WIRE = {
  helloTimeoutMs: HELLO_TIMEOUT_MS,
  channelIdleTimeoutSeconds: CHANNEL_IDLE_TIMEOUT_SECONDS,
} as const;
