/**
 * Isolation recipe for one Metalio listen turn (no HK, no websocat):
 * hello → uplink audio → listen stop → stt or a spoken tts sentence_start prompt, socket stays up.
 * The Xiaozhi device is never sent type:error.
 *
 *   node --disable-warning=ExperimentalWarning --experimental-strip-types --test test/lab-voice-listen-stop.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SESSION_CURSOR_TTL_MS } from "../integrations/openbot-b2/src/index.ts";
import {
  METALIO_DOWNLINK_SAMPLE_RATE,
  buildAbortMessage,
  buildClientHello,
  buildWebsocketHeaders,
  createLibopusFrameEncoder,
  encodeBinaryFrame,
  parseServerHello,
  pcmBytesPerFrame,
} from "../adapters/metalio/src/index.ts";
import { createReferenceHttpAsrProvider, type AsrProvider } from "../adapters/voice/src/index.ts";
import { ControlPlane } from "../services/src/index.ts";
import { startLabVoiceServer } from "../services/src/lab-voice.ts";
import { connectLabVoice, type LabVoiceClient, type WsFrame } from "../services/src/voice-ws.ts";

const PROMPT_NOT_HEARD = "没有听清，请再说一遍";
const PROMPT_UNAVAILABLE = "暂时无法回答，请稍后再试";

function plane(): ControlPlane {
  let refs = 0;
  let tokens = 0;
  return new ControlPlane({
    now: () => Date.now(),
    code: () => "042315",
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
    token: () => {
      tokens += 1;
      return `ctok_${tokens}`;
    },
  });
}

function bindDevice(control: ControlPlane, deviceId = "dev-voice"): string {
  control.redeemClaim(deviceId, control.issueClaim(deviceId).code);
  control.bind({
    deviceId,
    digitalHumanId: "dh-voice",
    assistant: { voiceId: "voice-lab" },
  });
  return control.issueConnectionCredential(deviceId).token;
}

async function readUntil(
  client: LabVoiceClient,
  accept: (frame: WsFrame) => boolean,
  limit = 40,
): Promise<WsFrame[]> {
  const frames: WsFrame[] = [];
  for (let index = 0; index < limit; index += 1) {
    const frame = await client.nextFrame();
    frames.push(frame);
    if (accept(frame)) {
      return frames;
    }
  }
  const preview = frames.map((frame) => (frame.opcode === 1 ? frame.payload.toString("utf8") : `bin:${frame.payload.length}`)).join("\n");
  throw new Error(`lab voice frame was not received\n${preview}`);
}

function textBody(frame: WsFrame): Record<string, unknown> | undefined {
  if (frame.opcode !== 1) {
    return undefined;
  }
  return JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
}

function isTtsSentenceStart(frame: WsFrame, text: string): boolean {
  const body = textBody(frame);
  return body?.type === "tts" && body.state === "sentence_start" && body.text === text;
}

async function hello(client: LabVoiceClient): Promise<string> {
  client.sendText(JSON.stringify(buildClientHello()));
  const frame = await client.nextFrame();
  const parsed = parseServerHello(JSON.parse(frame.payload.toString("utf8")));
  assert.equal(parsed.sampleRate, METALIO_DOWNLINK_SAMPLE_RATE);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.frameDurationMs, 60);
  const sessionId = parsed.sessionId ?? "";
  assert.equal(sessionId.length > 0, true);
  return sessionId;
}

async function expectAbort(client: LabVoiceClient, sessionId: string): Promise<void> {
  client.sendText(buildAbortMessage(sessionId, "wake_word_detected"));
  const frames = await readUntil(
    client,
    (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("lab.abort"),
  );
  const abort = textBody(frames[frames.length - 1] ?? { opcode: 0, payload: Buffer.alloc(0) });
  assert.equal(abort?.type, "lab.abort");
  assert.equal(
    frames.some((frame) => frame.opcode === 8),
    false,
  );
}

test("listen.stop with no uplink returns stt and keeps the socket", async () => {
  const control = plane();
  const token = bindDevice(control);
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: {} });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    const sessionId = await hello(client);
    client.sendText(JSON.stringify({ type: "listen", state: "start", mode: "manual", session_id: sessionId }));
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));
    const frames = await readUntil(
      client,
      (frame) => isTtsSentenceStart(frame, PROMPT_UNAVAILABLE),
    );
    const messages = frames.map((frame) => textBody(frame)).filter((body) => body !== undefined);
    assert.equal(
      messages.some((body) => body.type === "stt" && body.text === "lab-transcript"),
      true,
    );
    assert.equal(
      messages.some((body) => body.type === "tts" && body.state === "sentence_start" && body.text === PROMPT_UNAVAILABLE),
      true,
    );
    assert.equal(messages.some((body) => body.type === "error"), false);
    assert.equal(frames.some((frame) => frame.opcode === 8), false);
    await expectAbort(client, sessionId);
    client.close();
  } finally {
    await server.close();
  }
});

test("listen.stop survives empty, partial, junk, opus, and pcm uplink", async () => {
  const control = plane();
  const token = bindDevice(control);
  const encoder = createLibopusFrameEncoder({ sampleRate: 16000 });
  const opus = encoder.encodeFrame(Buffer.alloc(pcmBytesPerFrame(16000)));
  const server = await startLabVoiceServer(control, {
    host: "127.0.0.1",
    port: 0,
    env: { OPENBOT_DEVICE_DH_TEST_MODE: "1" },
  });
  const seen: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    seen.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    const sessionId = await hello(client);
    client.sendText(JSON.stringify({ type: "listen", state: "start", mode: "manual", session_id: sessionId }));
    client.sendBinary(Buffer.alloc(0));
    client.sendBinary(Buffer.from([0xfc]));
    client.sendBinary(Buffer.alloc(120, 0x01));
    client.sendBinary(opus);
    client.sendBinary(Buffer.alloc(1920, 0x11));
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));
    const frames = await readUntil(client, (frame) => {
      const body = textBody(frame);
      return body?.type === "stt";
    });
    const stt = textBody(frames[frames.length - 1] ?? { opcode: 0, payload: Buffer.alloc(0) });
    assert.equal(stt?.type, "stt");
    assert.equal(typeof stt?.text, "string");
    assert.equal((stt?.text as string).length > 0, true);
    assert.equal(frames.some((frame) => frame.opcode === 8), false);
    await expectAbort(client, sessionId);
    const diag = seen.filter((line) => line.includes("VOICE-DIAG") && line.includes("listen.stop"));
    assert.equal(diag.length > 0, true);
    assert.equal(diag.some((line) => line.includes(token)), false);
    assert.match(diag.join("\n"), /"packets":5/);
    assert.match(diag.join("\n"), /"approxDurationMs":240/);
    assert.equal(diag.some((line) => line.includes("Bearer")), false);
    client.close();
  } finally {
    process.stderr.write = originalWrite;
    encoder.destroy?.();
    await server.close();
  }
});

test("reference ASR posts decodable PCM and skips junk without closing", async () => {
  const control = plane();
  const token = bindDevice(control);
  const encoder = createLibopusFrameEncoder({ sampleRate: 16000 });
  const opus = encoder.encodeFrame(Buffer.alloc(pcmBytesPerFrame(16000)));
  const posts: Buffer[] = [];
  const asr = createReferenceHttpAsrProvider({
    url: "http://127.0.0.1:9/asr",
    fetchImpl: async (_input, init) => {
      const body = init?.body;
      posts.push(Buffer.from(body instanceof Uint8Array ? body : new Uint8Array()));
      return new Response(JSON.stringify({ text: "heard-from-asr" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const server = await startLabVoiceServer(control, {
    host: "127.0.0.1",
    port: 0,
    env: {},
    asrProvider: asr,
  });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    const sessionId = await hello(client);
    client.sendText(JSON.stringify({ type: "listen", state: "start", mode: "manual", session_id: sessionId }));
    client.sendBinary(Buffer.alloc(0));
    client.sendBinary(Buffer.alloc(120, 0x01));
    client.sendBinary(opus);
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));
    const frames = await readUntil(client, (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("heard-from-asr"));
    const stt = frames.map((frame) => textBody(frame)).find((body) => body?.type === "stt");
    assert.equal(stt?.text, "heard-from-asr");
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.byteLength, pcmBytesPerFrame(16000));
    assert.equal(frames.some((frame) => frame.opcode === 8), false);
    await expectAbort(client, sessionId);
    client.close();
  } finally {
    encoder.destroy?.();
    await server.close();
  }
});

test("undecodable uplink returns empty stt plus a not-heard prompt and stays open", async () => {
  const rejections: unknown[] = [];
  const onReject = (error: unknown) => {
    rejections.push(error);
  };
  process.on("unhandledRejection", onReject);
  const control = plane();
  const token = bindDevice(control);
  const asr = createReferenceHttpAsrProvider({
    url: "http://127.0.0.1:9/asr",
    fetchImpl: async () => {
      throw new Error("ASR must not be posted when nothing decoded");
    },
  });
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: {}, asrProvider: asr });
  const seen: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    seen.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    const sessionId = await hello(client);
    client.sendText(JSON.stringify({ type: "listen", state: "start", mode: "manual", session_id: sessionId }));
    client.sendBinary(Buffer.alloc(80, 0x7f));
    client.sendBinary(Buffer.alloc(120, 0x01));
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));
    const frames = await readUntil(
      client,
      (frame) => isTtsSentenceStart(frame, PROMPT_NOT_HEARD),
    );
    const messages = frames.map((frame) => textBody(frame)).filter((body) => body !== undefined);
    assert.equal(messages.some((body) => body.type === "stt" && body.text === ""), true);
    assert.equal(
      messages.some((body) => body.type === "tts" && body.state === "sentence_start" && body.text === PROMPT_NOT_HEARD),
      true,
    );
    assert.equal(messages.some((body) => body.type === "error"), false);
    const diag = seen.filter((line) => line.includes("VOICE-DIAG") && line.includes("uplink_incomplete")).join("\n");
    assert.match(diag, /"packets":2/);
    assert.match(diag, /"approxDurationMs":120/);
    assert.equal(frames.some((frame) => frame.opcode === 8), false);
    await expectAbort(client, sessionId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejections.length, 0);
    client.close();
  } finally {
    process.stderr.write = originalWrite;
    process.off("unhandledRejection", onReject);
    await server.close();
  }
});

test("ASR throw speaks a not-heard prompt and does not tear the socket down", async () => {
  const rejections: unknown[] = [];
  const onReject = (error: unknown) => {
    rejections.push(error);
  };
  process.on("unhandledRejection", onReject);
  const control = plane();
  const token = bindDevice(control);
  const asr: AsrProvider = {
    async transcribe() {
      throw new Error("Bearer ctok_secret grant-abcdefghijkl blew up");
    },
    async *stream() {
      throw new Error("Bearer ctok_secret grant-abcdefghijkl blew up");
    },
  };
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: {}, asrProvider: asr });
  const seen: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    seen.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    const sessionId = await hello(client);
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "should-not-crash" }));
    const frames = await readUntil(
      client,
      (frame) => isTtsSentenceStart(frame, PROMPT_NOT_HEARD),
    );
    const messages = frames.map((frame) => textBody(frame)).filter((body) => body !== undefined);
    assert.equal(messages.some((body) => body.type === "stt" && body.text === ""), true);
    assert.equal(
      messages.some((body) => body.type === "tts" && body.state === "sentence_start" && body.text === PROMPT_NOT_HEARD),
      true,
    );
    assert.equal(messages.some((body) => body.type === "error"), false);
    const frameText = frames.map((frame) => frame.payload.toString("utf8")).join("\n");
    assert.equal(frameText.includes("ctok_secret"), false);
    assert.equal(frameText.includes("grant-abcdefghijkl"), false);
    assert.equal(frames.some((frame) => frame.opcode === 8), false);
    await expectAbort(client, sessionId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejections.length, 0);
    const diag = seen.filter((line) => line.includes("VOICE-DIAG")).join("\n");
    assert.equal(diag.includes(token), false);
    assert.equal(diag.includes("ctok_secret"), false);
    assert.match(diag, /asr_failed/);
    assert.match(diag, /\[redacted\]/);
    client.close();
  } finally {
    process.stderr.write = originalWrite;
    process.off("unhandledRejection", onReject);
    await server.close();
  }
});

test("expired session cursor still returns stt instead of killing the process", async () => {
  const rejections: unknown[] = [];
  const onReject = (error: unknown) => {
    rejections.push(error);
  };
  process.on("unhandledRejection", onReject);
  let now = 1_700_000_000_000;
  const control = plane();
  const token = bindDevice(control);
  const server = await startLabVoiceServer(control, {
    host: "127.0.0.1",
    port: 0,
    env: {},
    now: () => now,
  });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    const sessionId = await hello(client);
    now += SESSION_CURSOR_TTL_MS;
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "after-cursor" }));
    const frames = await readUntil(client, (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("after-cursor"));
    const stt = frames.map((frame) => textBody(frame)).find((body) => body?.type === "stt");
    assert.equal(stt?.text, "after-cursor");
    assert.equal(frames.some((frame) => frame.opcode === 8), false);
    await expectAbort(client, sessionId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejections.length, 0);
    client.close();
  } finally {
    process.off("unhandledRejection", onReject);
    await server.close();
  }
});

test("a second hello does not kill the process or the first listen turn", async () => {
  const control = plane();
  const token = bindDevice(control);
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: {} });
  try {
    const headers = buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token });
    const first = await connectLabVoice(server.url, headers);
    const sessionId = await hello(first);
    const second = await connectLabVoice(server.url, headers);
    second.sendText(JSON.stringify(buildClientHello()));
    const again = textBody(await second.nextFrame());
    // Same device idempotency key reuses the open session instead of throwing out of the data handler.
    assert.equal(again?.type, "hello");
    assert.equal(again?.session_id, sessionId);
    first.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "still-here" }));
    const frames = await readUntil(first, (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("still-here"));
    assert.equal(frames.some((frame) => textBody(frame)?.type === "stt"), true);
    await expectAbort(first, sessionId);
    first.close();
    second.close();
  } finally {
    await server.close();
  }
});

test("protocol version 2 uplink is stripped to raw opus before ASR", async () => {
  const control = plane();
  const token = bindDevice(control);
  const encoder = createLibopusFrameEncoder({ sampleRate: 16000 });
  const opus = encoder.encodeFrame(Buffer.alloc(pcmBytesPerFrame(16000)));
  const seen: Buffer[] = [];
  const asr: AsrProvider = {
    async transcribe() {
      return "unused";
    },
    async *stream(chunks) {
      for await (const chunk of chunks) {
        seen.push(Buffer.from(chunk.data));
        if (chunk.endOfUtterance) {
          yield { final: "v2-stripped" };
        }
      }
    },
  };
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: {}, asrProvider: asr });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token, protocolVersion: 2 }),
    );
    client.sendText(JSON.stringify(buildClientHello(2)));
    const parsed = parseServerHello(JSON.parse((await client.nextFrame()).payload.toString("utf8")));
    assert.equal(parsed.sampleRate, 16000);
    const sessionId = parsed.sessionId ?? "";
    client.sendText(JSON.stringify({ type: "listen", state: "start", mode: "manual", session_id: sessionId }));
    client.sendBinary(encodeBinaryFrame({ version: 2, payload: opus, timestamp: 60 }));
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));
    const frames = await readUntil(client, (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("v2-stripped"));
    assert.equal(seen.length >= 1, true);
    assert.equal(seen[0]?.equals(opus), true);
    assert.equal(frames.some((frame) => frame.opcode === 8), false);
    client.close();
  } finally {
    encoder.destroy?.();
    await server.close();
  }
});

test("listen.detect does not finish the turn; later start plus uplink is transcribed", async () => {
  const control = plane();
  const token = bindDevice(control);
  const encoder = createLibopusFrameEncoder({ sampleRate: 16000 });
  const opus = encoder.encodeFrame(Buffer.alloc(pcmBytesPerFrame(16000)));
  const seen: Buffer[] = [];
  const asr: AsrProvider = {
    async transcribe() {
      return "unused";
    },
    async *stream(chunks) {
      for await (const chunk of chunks) {
        seen.push(Buffer.from(chunk.data));
        if (chunk.endOfUtterance) {
          yield { final: "from-uplink" };
        }
      }
    },
  };
  const logs: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: {}, asrProvider: asr });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    const sessionId = await hello(client);
    client.sendText(JSON.stringify({ type: "listen", state: "detect", session_id: sessionId, text: "Hi wake" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const earlyDiag = logs.filter((line) => line.includes("VOICE-DIAG")).join("\n");
    assert.match(earlyDiag, /listen\.detect/);
    assert.equal(earlyDiag.includes("listen.finish.start"), false);
    client.sendText(JSON.stringify({ type: "listen", state: "start", mode: "manual", session_id: sessionId }));
    client.sendBinary(opus);
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));
    const frames = await readUntil(client, (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("from-uplink"));
    const messages = frames.map((frame) => textBody(frame)).filter((body) => body !== undefined);
    assert.equal(messages.some((body) => body.type === "stt" && body.text === "from-uplink"), true);
    assert.equal(messages.some((body) => body.type === "stt" && body.text === "Hi wake"), false);
    assert.equal(messages.some((body) => body.type === "error"), false);
    assert.equal(seen.some((packet) => packet.equals(opus)), true);
    const diag = logs.filter((line) => line.includes("VOICE-DIAG")).join("\n");
    assert.match(diag, /listen\.detect/);
    assert.match(diag, /"textChars":7/);
    assert.equal(diag.includes("Hi wake"), false);
    client.close();
  } finally {
    process.stderr.write = originalWrite;
    encoder.destroy?.();
    await server.close();
  }
});

test("detect then start then empty stop speaks a not-heard prompt", async () => {
  const control = plane();
  const token = bindDevice(control);
  const asr: AsrProvider = {
    async transcribe() {
      return "";
    },
    async *stream(chunks) {
      for await (const chunk of chunks) {
        if (chunk.endOfUtterance) {
          yield { final: "" };
        }
      }
    },
  };
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: {}, asrProvider: asr });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    const sessionId = await hello(client);
    client.sendText(JSON.stringify({ type: "listen", state: "detect", session_id: sessionId, text: "Hi wake" }));
    client.sendText(JSON.stringify({ type: "listen", state: "start", mode: "manual", session_id: sessionId }));
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));
    const frames = await readUntil(
      client,
      (frame) => isTtsSentenceStart(frame, PROMPT_NOT_HEARD),
    );
    const messages = frames.map((frame) => textBody(frame)).filter((body) => body !== undefined);
    assert.equal(messages.some((body) => body.type === "stt" && body.text === ""), true);
    assert.equal(
      messages.some((body) => body.type === "tts" && body.state === "sentence_start" && body.text === PROMPT_NOT_HEARD),
      true,
    );
    assert.equal(messages.some((body) => body.type === "error"), false);
    assert.equal(frames.some((frame) => frame.opcode === 8), false);
    await expectAbort(client, sessionId);
    client.close();
  } finally {
    await server.close();
  }
});

test("empty in-flight finish is cancelled by a later start and the next stop is transcribed", async () => {
  const control = plane();
  const token = bindDevice(control);
  let calls = 0;
  const asr: AsrProvider = {
    async transcribe() {
      return "unused";
    },
    async *stream(chunks) {
      for await (const chunk of chunks) {
        if (chunk.endOfUtterance) {
          calls += 1;
          if (calls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            yield { final: "first-empty" };
            return;
          }
          yield { final: "second-turn" };
        }
      }
    },
  };
  const logs: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  const encoder = createLibopusFrameEncoder({ sampleRate: 16000 });
  const opus = encoder.encodeFrame(Buffer.alloc(pcmBytesPerFrame(16000)));
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: {}, asrProvider: asr });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    const sessionId = await hello(client);
    client.sendText(JSON.stringify({ type: "listen", state: "start", mode: "manual", session_id: sessionId }));
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.sendText(JSON.stringify({ type: "listen", state: "start", mode: "manual", session_id: sessionId }));
    client.sendBinary(opus);
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId }));
    const frames = await readUntil(client, (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("second-turn"));
    const messages = frames.map((frame) => textBody(frame)).filter((body) => body !== undefined);
    assert.equal(messages.some((body) => body.type === "stt" && body.text === "second-turn"), true);
    assert.equal(messages.some((body) => body.type === "stt" && body.text === "first-empty"), false);
    assert.equal(messages.some((body) => body.type === "error"), false);
    const diag = logs.filter((line) => line.includes("VOICE-DIAG")).join("\n");
    assert.match(diag, /listen\.finish\.cancelled/);
    client.close();
  } finally {
    process.stderr.write = originalWrite;
    encoder.destroy?.();
    await server.close();
  }
});
