import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsFrame {
  opcode: number;
  payload: Buffer;
}

export function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

export function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  return encodeFrame(opcode, payload, null);
}

export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  return encodeFrame(opcode, payload, randomBytes(4));
}

function encodeFrame(opcode: number, payload: Buffer, mask: Buffer | null): Buffer {
  const masked = mask === null ? 0 : 0x80;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = masked | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = masked | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    throw new Error("websocket frame exceeds 65535 bytes");
  }
  header[0] = 0x80 | opcode;
  if (mask === null) {
    return Buffer.concat([header, payload]);
  }
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) {
    const maskByte = mask[index % 4];
    const value = body[index];
    if (maskByte === undefined || value === undefined) {
      break;
    }
    body[index] = value ^ maskByte;
  }
  return Buffer.concat([header, mask, body]);
}

export class WsFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): WsFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = this.readFrame();
      if (frame === undefined) {
        return frames;
      }
      frames.push(frame);
    }
  }

  private readFrame(): WsFrame | undefined {
    if (this.buffer.length < 2) {
      return undefined;
    }
    const first = this.buffer[0];
    const second = this.buffer[1];
    if (first === undefined || second === undefined) {
      return undefined;
    }
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) {
        return undefined;
      }
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      throw new Error("websocket frame exceeds 65535 bytes");
    }
    const maskLength = masked ? 4 : 0;
    if (this.buffer.length < offset + maskLength + length) {
      return undefined;
    }
    const payload = Buffer.from(this.buffer.subarray(offset + maskLength, offset + maskLength + length));
    if (masked) {
      const mask = this.buffer.subarray(offset, offset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        const maskByte = mask[index % 4];
        const value = payload[index];
        if (maskByte === undefined || value === undefined) {
          break;
        }
        payload[index] = value ^ maskByte;
      }
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset + maskLength + length));
    return { opcode, payload };
  }
}

export interface LabVoiceClient {
  sendText(text: string): void;
  sendBinary(payload: Buffer): void;
  nextFrame(): Promise<WsFrame>;
  close(): void;
}

export function connectLabVoice(url: string, headers: Record<string, string>): Promise<LabVoiceClient> {
  const parsed = new URL(url);
  const port = parsed.port.length === 0 ? 80 : Number(parsed.port);
  const key = randomBytes(16).toString("base64");
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  const request = [
    `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
    `Host: ${parsed.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    ...headerLines,
    "",
    "",
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const socket = connect({ host: parsed.hostname, port }, () => {
      socket.write(request);
    });
    const decoder = new WsFrameDecoder();
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    let handshake = Buffer.alloc(0);
    let open = false;
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.on("data", (chunk: Buffer) => {
      if (!open) {
        handshake = Buffer.concat([handshake, chunk]);
        const split = handshake.indexOf("\r\n\r\n");
        if (split < 0) {
          return;
        }
        const head = handshake.subarray(0, split).toString("utf8");
        if (!head.startsWith("HTTP/1.1 101")) {
          fail(new Error(head.split("\r\n")[0] ?? "websocket upgrade failed"));
          return;
        }
        const accept = /Sec-WebSocket-Accept: (.+)/i.exec(head)?.[1]?.trim();
        if (accept !== websocketAccept(key)) {
          fail(new Error("websocket accept mismatch"));
          return;
        }
        open = true;
        const rest = handshake.subarray(split + 4);
        handshake = Buffer.alloc(0);
        if (rest.length > 0) {
          pushFrames(decoder.push(rest));
        }
        resolve({
          sendText(text: string) {
            socket.write(encodeClientFrame(1, Buffer.from(text)));
          },
          sendBinary(payload: Buffer) {
            socket.write(encodeClientFrame(2, payload));
          },
          nextFrame() {
            const existing = queue.shift();
            if (existing) {
              return Promise.resolve(existing);
            }
            return new Promise((done) => {
              waiters.push(done);
            });
          },
          close() {
            socket.end();
          },
        });
        return;
      }
      pushFrames(decoder.push(chunk));
    });
    socket.on("error", (error) => {
      if (!open) {
        fail(error);
      }
    });

    function pushFrames(frames: WsFrame[]): void {
      for (const frame of frames) {
        const waiter = waiters.shift();
        if (waiter) {
          waiter(frame);
        } else {
          queue.push(frame);
        }
      }
    }
  });
}

export function takeSocket(socket: Duplex): void {
  if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }
}
