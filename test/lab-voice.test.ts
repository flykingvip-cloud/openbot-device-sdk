import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import {
  DECODE_QUEUE_BUDGET_MS,
  OPUS_PLACEHOLDER_MAGIC,
  buildAbortMessage,
  buildClientHello,
  buildWebsocketHeaders,
  parseServerHello,
} from "../adapters/metalio/src/index.ts";
import { ControlPlane } from "../services/src/index.ts";
import { LabPlayQueue, mockAsrTranscript, startLabVoiceServer } from "../services/src/lab-voice.ts";
import { connectLabVoice, type WsFrame } from "../services/src/voice-ws.ts";

function plane(): ControlPlane {
  let refs = 0;
  let tokens = 0;
  return new ControlPlane({
    now: () => 1_700_000_000_000,
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

function planeClock(now: () => number): ControlPlane {
  let refs = 0;
  let tokens = 0;
  return new ControlPlane({
    now,
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

function bindDevice(control: ControlPlane): { token: string; expiresAtMs: number } {
  control.redeemClaim("dev-voice", control.issueClaim("dev-voice").code);
  control.bind({
    deviceId: "dev-voice",
    digitalHumanId: "dh-voice",
    assistant: { voiceId: "voice-lab" },
  });
  const credential = control.issueConnectionCredential("dev-voice");
  return { token: credential.token, expiresAtMs: credential.expiresAtMs };
}

async function readUntil(client: { nextFrame: () => Promise<WsFrame> }, accept: (frame: WsFrame) => boolean): Promise<WsFrame[]> {
  const frames: WsFrame[] = [];
  for (let index = 0; index < 40; index += 1) {
    const frame = await client.nextFrame();
    frames.push(frame);
    if (accept(frame)) {
      return frames;
    }
  }
  throw new Error("lab voice frame was not received");
}

test("play queue keeps the 2400 ms residual and does not clear it on abort", () => {
  const queue = new LabPlayQueue();
  queue.start();
  const frame = Buffer.from(OPUS_PLACEHOLDER_MAGIC);
  for (let index = 0; index < 40; index += 1) {
    assert.equal(queue.sent(frame), "queued");
  }
  assert.equal(queue.sent(frame), "blocked");
  assert.equal(queue.residualMs(), DECODE_QUEUE_BUDGET_MS);
  const report = queue.abort("sess_lab");
  assert.equal(report.queueCleared, false);
  assert.equal(report.residualMs, 2400);
  assert.equal(mockAsrTranscript({}), "lab-transcript");
  assert.equal(mockAsrTranscript({ binaryNote: "ASR:from-audio" }), "from-audio");
  assert.equal(mockAsrTranscript({ listenText: "typed" }), "typed");
});

test("lab voice accepts Metalio hello, hands a turn to B2, and stops TTS on abort", async () => {
  const control = plane();
  const { token } = bindDevice(control);
  const server = await startLabVoiceServer(control, {
    host: "127.0.0.1",
    port: 0,
    env: { OPENBOT_DEVICE_DH_TEST_MODE: "1" },
  });
  try {
    await assert.rejects(
      () => connectLabVoice(server.url, buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1" })),
      /401/,
    );
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const helloFrame = await client.nextFrame();
    assert.equal(helloFrame.opcode, 1);
    const hello = parseServerHello(JSON.parse(helloFrame.payload.toString("utf8")));
    assert.equal(hello.transport, "websocket");
    assert.equal(hello.sampleRate, 24000);
    assert.equal(hello.frameDurationMs, 60);
    const sessionId = hello.sessionId ?? "";
    assert.equal(sessionId.length > 0, true);

    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "lab-heard" }));
    const beforeAbort = await readUntil(client, (frame) => frame.opcode === 2);
    assert.equal(beforeAbort.some((frame) => frame.payload.toString("utf8").includes("lab-heard")), true);
    assert.equal(beforeAbort.some((frame) => frame.payload.includes(OPUS_PLACEHOLDER_MAGIC)), true);
    const spoken = beforeAbort
      .filter((frame) => frame.opcode === 1)
      .map((frame) => JSON.parse(frame.payload.toString("utf8")) as { type?: string; dialogue?: string; source?: string; text?: string; state?: string });
    assert.equal(
      spoken.some((frame) => frame.type === "stt" && frame.dialogue === "sim" && frame.source === "sim" && frame.text === "lab-heard"),
      true,
    );
    assert.equal(
      spoken.some((frame) => frame.type === "tts" && frame.state === "start" && frame.dialogue === "sim" && frame.source === "sim" && frame.text === "lab-heard"),
      true,
    );

    client.sendText(buildAbortMessage(sessionId, "wake_word_detected"));
    const untilAbort = await readUntil(client, (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("lab.abort"));
    const abortBody = JSON.parse(untilAbort[untilAbort.length - 1]?.payload.toString("utf8") ?? "{}") as {
      residualMs: number;
      queueCleared: boolean;
      residualCapMs: number;
    };
    assert.equal(abortBody.queueCleared, false);
    assert.equal(abortBody.residualCapMs, 2400);
    assert.equal(abortBody.residualMs > 0, true);
    assert.equal(abortBody.residualMs <= 2400, true);
    assert.equal(abortBody.residualMs % 60, 0);

    const extra = await Promise.race([
      client.nextFrame(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 40);
      }),
    ]);
    assert.equal(extra, null);

    const pulled = server.book.pull(sessionId, 0);
    assert.equal(pulled.events.length, 1);
    assert.equal(pulled.events[0]?.type, "user.turn");
    assert.equal(server.url.includes("tenclass"), false);
    client.close();
  } finally {
    await server.close();
  }
});

test("expired token is rejected on connect", async () => {
  let now = 1_700_000_000_000;
  const control = planeClock(() => now);
  const { token, expiresAtMs } = bindDevice(control);
  now = expiresAtMs;
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0 });
  try {
    await assert.rejects(
      () => connectLabVoice(server.url, buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token })),
      /401/,
    );
    const decision = control.assessConnectionCredential("dev-voice", token);
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.code, "credential_expired");
    }
  } finally {
    await server.close();
  }
});

test("mid-session expiry closes the socket and does not finish the utterance", async () => {
  let now = 1_700_000_000_000;
  const control = planeClock(() => now);
  const { token, expiresAtMs } = bindDevice(control);
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0 });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const helloFrame = await client.nextFrame();
    const hello = parseServerHello(JSON.parse(helloFrame.payload.toString("utf8")));
    const sessionId = hello.sessionId ?? "";
    assert.equal(sessionId.length > 0, true);
    assert.equal(server.book.pull(sessionId, 0).events.some((event) => event.type === "user.turn"), false);

    now = expiresAtMs;
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "too-late" }));
    const frame = await client.nextFrame();
    assert.equal(frame.opcode, 1);
    const body = JSON.parse(frame.payload.toString("utf8")) as { type: string; code: string };
    assert.equal(body.type, "error");
    assert.equal(body.code, "credential_expired");
    assert.equal(server.book.pull(sessionId, 0).events.some((event) => event.type === "user.turn"), false);
    assert.equal(server.book.pull(sessionId, 0).events.some((event) => event.type === "stt"), false);
    client.close();
  } finally {
    await server.close();
  }
});

interface VoiceCall {
  method: string;
  path: string;
  body: unknown;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function voiceEnvelope(type: string, text?: string): string {
  return `data: ${JSON.stringify({ eventId: `evt-${type}`, type, payload: text === undefined ? {} : { text }, data: {} })}\n\n`;
}

async function startVoiceStub(holdEvents: boolean): Promise<{ origin: string; calls: VoiceCall[]; close: () => Promise<void> }> {
  const calls: VoiceCall[] = [];
  let held: ServerResponse | undefined;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    sockets.add(req.socket);
    req.socket.on("close", () => {
      sockets.delete(req.socket);
    });
    void (async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const body = req.method === "GET" ? undefined : await readJson(req);
      calls.push({ method: req.method ?? "", path, body });
      const grant = {
        authorizationRef: "aref-voice",
        bindingVersion: 2,
        digitalHumanId: "dh-voice",
        deviceId: "dev-voice",
        status: "active",
        assistant: { digitalHumanId: "dh-voice", displayName: "Voice", status: "active" },
      };
      if (req.method === "GET" && path === "/api/integrations/v1/grants/aref-voice") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(grant));
        return;
      }
      if (req.method === "POST" && path === "/api/integrations/v1/conversations") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ conversationId: "conv-voice", ...grant }));
        return;
      }
      if (req.method === "POST" && path.endsWith("/turns")) {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ runId: "run-voice", turnId: "turn-1", disposition: "accepted", ...grant }));
        return;
      }
      if (req.method === "GET" && path.endsWith("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (holdEvents) {
          held = res;
          res.flushHeaders();
          return;
        }
        res.write(voiceEnvelope("assistant.delta", "asr-distinct"));
        res.write(voiceEnvelope("assistant.visible", "openbot-visible"));
        res.end(voiceEnvelope("assistant.final", "openbot-final"));
        return;
      }
      if (req.method === "POST" && path.endsWith("/cancel")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ runId: "run-voice", accepted: true, status: "cancelled", sideEffectsRolledBack: false, reason: "barge_in" }));
        held?.end(voiceEnvelope("run.cancelled"));
        held = undefined;
        return;
      }
      res.writeHead(404);
      res.end("{}");
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end("{}");
    });
  });
  const origin = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("voice stub has no port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return {
    origin,
    calls,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function voiceLiveEnv(origin: string): NodeJS.ProcessEnv {
  return {
    OPENBOT_DEVICE_DH_STUB_URL: origin,
    OPENBOT_STUB_SERVICE_USER: "svc-user",
    OPENBOT_STUB_SERVICE_PASSWORD: "svc-pass",
    OPENBOT_STUB_GRANT_CREDENTIAL: "grant-voice",
    OPENBOT_STUB_AUTHORIZATION_REF: "aref-voice",
    OPENBOT_STUB_BINDING_VERSION: "2",
    OPENBOT_DEVICE_DH_GATEWAY_AGENT_ID: "agent-voice",
  };
}

function jsonFrames(frames: WsFrame[]): Array<Record<string, unknown>> {
  return frames
    .filter((frame) => frame.opcode === 1)
    .map((frame) => JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>);
}

test("lab voice speaks OpenBot visible text and not the ASR transcript", async () => {
  const control = plane();
  const { token } = bindDevice(control);
  const stub = await startVoiceStub(false);
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: voiceLiveEnv(stub.origin) });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const hello = parseServerHello(JSON.parse((await client.nextFrame()).payload.toString("utf8")));
    const sessionId = hello.sessionId ?? "";
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "asr-distinct" }));
    const frames: WsFrame[] = [];
    const deadline = Date.now() + 2000;
    let finished = false;
    while (Date.now() < deadline && frames.length < 40) {
      const frame = await Promise.race([
        client.nextFrame(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 200);
        }),
      ]);
      if (frame === null) {
        break;
      }
      frames.push(frame);
      if (frame.opcode !== 1) {
        continue;
      }
      const body = JSON.parse(frame.payload.toString("utf8")) as { type?: string; state?: string };
      if (body.type === "tts" && body.state === "stop") {
        const stops = frames.filter((item) => item.opcode === 1 && item.payload.toString("utf8").includes("\"state\":\"stop\"")).length;
        if (stops >= 2) {
          finished = true;
          break;
        }
      }
    }
    assert.equal(finished, true, frames.map((frame) => frame.payload.toString("utf8")).join("\n"));
    const messages = jsonFrames(frames);
    assert.equal(
      messages.some((frame) => frame.type === "stt" && frame.text === "asr-distinct" && frame.dialogue === "sim" && frame.source === "sim-asr"),
      true,
    );
    const tts = messages.filter((frame) => frame.type === "tts" && frame.state === "start");
    assert.deepEqual(
      tts.map((frame) => frame.text),
      ["openbot-visible", "openbot-final"],
    );
    assert.equal(tts.every((frame) => frame.dialogue === "openbot" && frame.source === "openbot"), true);
    assert.equal(tts.some((frame) => frame.text === "asr-distinct"), false);
    const turn = stub.calls.find((call) => call.path.endsWith("/turns"));
    const turnBody = turn?.body as { agentSessionKey?: string; gatewayAgentId?: string; text?: string };
    assert.equal(turnBody.gatewayAgentId, "agent-voice");
    assert.equal(turnBody.agentSessionKey, "device-dh:dh-voice:conv-voice");
    assert.equal(turnBody.text, "asr-distinct");
    client.close();
  } finally {
    await server.close();
    await stub.close();
  }
});

test("lab voice barge-in cancels the OpenBot run and does not speak the ASR text", async () => {
  const control = plane();
  const { token } = bindDevice(control);
  const stub = await startVoiceStub(true);
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: voiceLiveEnv(stub.origin) });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const hello = parseServerHello(JSON.parse((await client.nextFrame()).payload.toString("utf8")));
    const sessionId = hello.sessionId ?? "";
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "do-not-speak-asr" }));
    const started = Date.now();
    while (!stub.calls.some((call) => call.path.endsWith("/events"))) {
      if (Date.now() - started > 2000) {
        throw new Error("run events were not opened");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    client.sendText(buildAbortMessage(sessionId, "wake_word_detected"));
    const frames: WsFrame[] = [];
    const abortDeadline = Date.now() + 2000;
    while (Date.now() < abortDeadline && frames.length < 20) {
      const frame = await Promise.race([
        client.nextFrame(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 200);
        }),
      ]);
      if (frame === null) {
        break;
      }
      frames.push(frame);
      if (frame.opcode === 1 && frame.payload.toString("utf8").includes("lab.abort")) {
        break;
      }
    }
    assert.equal(frames.some((frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("lab.abort")), true);
    const cancelStarted = Date.now();
    while (!stub.calls.some((call) => call.path.endsWith("/cancel"))) {
      if (Date.now() - cancelStarted > 2000) {
        throw new Error("cancel was not posted");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const messages = jsonFrames(frames);
    assert.equal(messages.some((frame) => frame.type === "tts"), false);
    assert.equal(frames.some((frame) => frame.opcode === 2), false);
    assert.equal(messages.some((frame) => frame.type === "stt" && frame.text === "do-not-speak-asr"), true);
    const cancel = stub.calls.find((call) => call.path.endsWith("/cancel"));
    assert.deepEqual(cancel?.body, { reason: "barge_in", turnId: "turn-1" });
    client.close();
  } finally {
    await server.close();
    await stub.close();
  }
});

test("without TEST_MODE the lab voice does not speak the ASR text", async () => {
  const control = plane();
  const { token } = bindDevice(control);
  const server = await startLabVoiceServer(control, { host: "127.0.0.1", port: 0, env: {} });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const hello = parseServerHello(JSON.parse((await client.nextFrame()).payload.toString("utf8")));
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: hello.sessionId, text: "should-not-speak" }));
    const frames = await readUntil(client, (frame) => frame.opcode === 1 && frame.payload.toString("utf8").includes("dialogue_unavailable"));
    const messages = jsonFrames(frames);
    assert.equal(messages.some((frame) => frame.type === "tts"), false);
    assert.equal(frames.some((frame) => frame.opcode === 2), false);
    assert.equal(messages.some((frame) => frame.type === "error" && frame.code === "dialogue_unavailable"), true);
    client.close();
  } finally {
    await server.close();
  }
});

test("partial live credentials become an error frame instead of simulated speech", async () => {
  const control = plane();
  const { token } = bindDevice(control);
  const server = await startLabVoiceServer(control, {
    host: "127.0.0.1",
    port: 0,
    env: {
      OPENBOT_DEVICE_DH_STUB_URL: "http://127.0.0.1:9",
      OPENBOT_STUB_SERVICE_USER: "svc-user",
    },
  });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-voice", clientId: "client-1", token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const hello = parseServerHello(JSON.parse((await client.nextFrame()).payload.toString("utf8")));
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: hello.sessionId, text: "should-not-speak" }));
    const frame = await client.nextFrame();
    const body = JSON.parse(frame.payload.toString("utf8")) as { type?: string; code?: string };
    if (body.type === "stt") {
      const errorFrame = await client.nextFrame();
      const errorBody = JSON.parse(errorFrame.payload.toString("utf8")) as { type?: string; code?: string };
      assert.equal(errorBody.type, "error");
      assert.equal(errorBody.code, "live_stub");
    } else {
      assert.equal(body.type, "error");
      assert.equal(body.code, "live_stub");
    }
    const extra = await Promise.race([
      client.nextFrame(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 40);
      }),
    ]);
    assert.equal(extra, null);
    client.close();
  } finally {
    await server.close();
  }
});
