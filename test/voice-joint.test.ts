import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GRANT_CREDENTIAL_HEADER,
  LIVE_STUB_ENV,
  STUB_DEVICE_ID_ENV,
  STUB_GRANT_CREDENTIAL_ENV,
  STUB_SERVICE_PASSWORD_ENV,
  STUB_SERVICE_USER_ENV,
  basicAuthorization,
} from "../contracts/src/index.ts";
import {
  DEVICE_ID_HEADER,
  VOICE_JOINT_CONTROL_URL_ENV,
  VOICE_JOINT_PENDING,
  formatVoiceJointReport,
  runVoiceJointLoopback,
  voiceJointMissingEnv,
} from "../services/src/voice-joint.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = "services/src/voice-joint-cli.ts";
const USER = "svc-voice-joint";
const PASSWORD = "svc-secret";
const DEVICE_ID = "dev-voice-joint-1";
const GRANT = "cred-voice-joint";
const TRANSCRIPT = "passthrough-hello";

test("voice-joint CLI skips without stub credentials and does not claim a pass", () => {
  const help = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli, "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /127\.0\.0\.1:8787/);
  assert.match(help.stdout, /ASR\/passthrough/);
  assert.match(help.stdout, /npm run sim/);
  assert.match(help.stdout, /claw4-firmware-http-compat/);
  assert.match(help.stdout, /HTTP compat smoke|不是 voice E2E/);
  assert.equal(help.stdout.includes("api.tenclass.net"), false);

  const env = { ...process.env };
  for (const name of [LIVE_STUB_ENV, STUB_SERVICE_USER_ENV, STUB_SERVICE_PASSWORD_ENV, STUB_GRANT_CREDENTIAL_ENV, STUB_DEVICE_ID_ENV]) {
    delete env[name];
  }
  assert.equal(voiceJointMissingEnv(env).includes(LIVE_STUB_ENV), true);
  const skipped = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /跳过 voice-joint/);
  assert.match(skipped.stdout, /跳过不是通过/);
  assert.match(skipped.stdout, /不扩展 npm run sim/);
  assert.match(skipped.stdout, /JOINT_PENDING/);
});

test("voice joint upload+messages on loopback stub; data.text is passthrough", async () => {
  const calls: string[] = [];
  let storedConversationId = "conv_voice_joint_1";
  let storedTranscript = "";

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { code: 500, error: { code: "RUN_FAILED", message: "stub failed", retryable: false } });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    calls.push(`${req.method ?? "GET"} ${path}`);
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!checkAuth(req, res)) {
      return;
    }
    if (req.method === "POST" && path === "/api/v1/upload") {
      const body = await readBody(req);
      assert.ok(body.byteLength >= 44);
      const contentType = String(req.headers["content-type"] ?? "");
      assert.match(contentType, /audio\/wav/i);
      storedTranscript = url.searchParams.get("transcript") ?? "";
      writeJson(res, 200, { code: 0, data: { text: storedTranscript, conversationId: storedConversationId } });
      return;
    }
    const messagesMatch = /^\/api\/v1\/conversation\/([^/]+)\/messages$/.exec(path);
    if (req.method === "GET" && messagesMatch !== null) {
      const id = decodeURIComponent(messagesMatch[1] ?? "");
      writeJson(res, 200, {
        code: 0,
        data: {
          conversationId: id,
          messages: [{ id: "m1", role: "user", text: storedTranscript }],
        },
      });
      return;
    }
    if (req.method === "POST" && path === "/api/v1/record/upload") {
      writeJson(res, 200, { code: 0, data: { text: "record-reserved", conversationId: storedConversationId } });
      return;
    }
    writeJson(res, 404, { code: 404, error: { code: "NOT_FOUND", message: path, retryable: false } });
  }

  await listen(server);
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const control = createServer((_req, res) => {
    writeJson(res, 200, {
      maturity: "v1-frozen",
      grayRelease: false,
      realDeviceDelivery: false,
    });
  });
  await listen(control);
  const controlAddr = control.address();
  assert.ok(controlAddr !== null && typeof controlAddr === "object");
  const controlOrigin = `http://127.0.0.1:${controlAddr.port}`;

  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [LIVE_STUB_ENV]: origin,
      [STUB_SERVICE_USER_ENV]: USER,
      [STUB_SERVICE_PASSWORD_ENV]: PASSWORD,
      [STUB_GRANT_CREDENTIAL_ENV]: GRANT,
      [STUB_DEVICE_ID_ENV]: DEVICE_ID,
      [VOICE_JOINT_CONTROL_URL_ENV]: controlOrigin,
    };
    const report = await runVoiceJointLoopback({ env, transcript: TRANSCRIPT });
    assert.equal(report.uploadText, TRANSCRIPT);
    assert.equal(report.conversationId, storedConversationId);
    assert.equal(report.messagesOk, true);
    assert.equal(report.controlHealthOk, true);
    assert.equal(report.controlMaturity, "v1-frozen");
    assert.equal(report.simUnchanged, true);
    assert.deepEqual([...report.pending], [...VOICE_JOINT_PENDING]);
    assert.ok(report.checks.some((c) => c.name === "claw4.upload.passthrough"));
    assert.ok(report.checks.some((c) => c.name === "device-control.health.dual-command"));
    assert.ok(calls.includes("POST /api/v1/upload"));
    assert.ok(calls.some((c) => c.startsWith("GET /api/v1/conversation/")));
    const formatted = formatVoiceJointReport(report);
    assert.match(formatted, /NOT npm run sim|HTTP compat smoke/);
    assert.match(formatted, /ASR\/passthrough/);
    assert.match(formatted, /claw4-firmware-http-compat/);
    assert.equal(formatted.includes(GRANT), false);
    assert.equal(formatted.includes(PASSWORD), false);
  } finally {
    await close(server);
    await close(control);
  }
});

test("voice joint rejects device id mismatch style auth failure from stub", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    writeJson(res, 401, {
      code: 401,
      error: { code: "BINDING_MISMATCH", message: "X-Device-Id must equal grant.deviceId", retryable: false },
    });
  });
  await listen(server);
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(
      () =>
        runVoiceJointLoopback({
          env: {
            ...process.env,
            [LIVE_STUB_ENV]: origin,
            [STUB_SERVICE_USER_ENV]: USER,
            [STUB_SERVICE_PASSWORD_ENV]: PASSWORD,
            [STUB_GRANT_CREDENTIAL_ENV]: GRANT,
            [STUB_DEVICE_ID_ENV]: "wrong-device",
          },
          transcript: TRANSCRIPT,
        }),
      /BINDING_MISMATCH|upload failed/,
    );
  } finally {
    await close(server);
  }
});

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const expected = basicAuthorization(USER, PASSWORD);
  if (req.headers.authorization !== expected) {
    writeJson(res, 401, { code: 401, error: { code: "AUTH_INVALID", message: "basic", retryable: false } });
    return false;
  }
  if (req.headers[GRANT_CREDENTIAL_HEADER.toLowerCase()] !== GRANT) {
    writeJson(res, 401, { code: 401, error: { code: "AUTH_REVOKED", message: "grant", retryable: false } });
    return false;
  }
  if (req.headers[DEVICE_ID_HEADER.toLowerCase()] !== DEVICE_ID) {
    writeJson(res, 401, {
      code: 401,
      error: { code: "BINDING_MISMATCH", message: "X-Device-Id must equal grant.deviceId", retryable: false },
    });
    return false;
  }
  return true;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
    server.on("error", reject);
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
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
