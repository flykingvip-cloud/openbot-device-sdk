import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GRANT_CREDENTIAL_HEADER,
  LIVE_STUB_ENV,
  OPENBOT_CONTRACT_SHA,
  STUB_AUTHORIZATION_REF_ENV,
  STUB_BINDING_VERSION_ENV,
  STUB_DEVICE_ID_ENV,
  STUB_DIGITAL_HUMAN_ID_ENV,
  STUB_GRANT_CREDENTIAL_ENV,
  STUB_SERVICE_PASSWORD_ENV,
  STUB_SERVICE_USER_ENV,
  basicAuthorization,
  resolveStubLocation,
  serviceGrantHeaders,
} from "../contracts/src/index.ts";
import { readDigitalHuman } from "../integrations/openbot-b1/src/index.ts";
import { formatLiveStubReport, runLiveStubProbe } from "../integrations/openbot-live/src/index.ts";
import { LabCameraSession, startLabMediaServer } from "../integrations/openbot-media/src/index.ts";
import { ControlPlane } from "../services/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../integrations/openbot-live/src/cli.ts", import.meta.url));

function runCliAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", ...args], {
      cwd: root,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("stub test server has no port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("loopback stub URL rejects public hosts and keeps healthz on the origin", () => {
  assert.throws(() => resolveStubLocation("https://api.tenclass.net"), /loopback/);
  assert.throws(() => resolveStubLocation("http://svc:secret@127.0.0.1:8787"), /credentials/);
  const located = resolveStubLocation("http://127.0.0.1:8787/api/integrations/v1");
  assert.equal(located.origin, "http://127.0.0.1:8787");
  assert.equal(located.healthPath, "/healthz");
  assert.equal(located.integrationsBase, "http://127.0.0.1:8787/api/integrations/v1");
  assert.equal(serviceGrantHeaders({}), undefined);
  assert.throws(
    () => serviceGrantHeaders({ [STUB_SERVICE_USER_ENV]: "svc" }),
    /must both be set/,
  );
});

test("probe reads root healthz and skips the profile when credentials are unset", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(req.url === "/healthz" ? 200 : 500);
    res.end("ok");
  });
  const origin = await listen(server);
  try {
    const report = await runLiveStubProbe({
      env: { [LIVE_STUB_ENV]: `${origin}/api/integrations/v1` },
    });
    assert.equal(report.contractSha, OPENBOT_CONTRACT_SHA);
    assert.equal(report.routesAligned, true);
    assert.equal(report.firmwareUrl, null);
    assert.equal(report.healthOk, true);
    assert.equal(report.healthPath, "/healthz");
    assert.equal(report.integrationsPrefix, "/api/integrations/v1");
    assert.deepEqual(seen, ["/healthz"]);
    assert.equal(report.profile.state, "skipped");
    assert.equal(report.camera.state, "skipped");
    assert.equal(report.notCalled.includes("flash"), true);
    assert.equal(report.notCalled.includes("massFlash"), true);
    assert.equal(formatLiveStubReport(report).includes("不是灰度交付"), true);
  } finally {
    await close(server);
  }
});

test("profile GET sends service basic and the grant header", async () => {
  const authorization = basicAuthorization("svc", "lab-secret");
  let profileHeaders: Headers | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/healthz")) {
      return new Response("ok", { status: 200 });
    }
    profileHeaders = new Headers(init?.headers);
    assert.equal(url, "http://127.0.0.1:8787/api/integrations/v1/digital-humans/dh-live");
    return new Response(JSON.stringify({ digitalHumanId: "dh-live", assistant: { voiceId: "v" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const report = await runLiveStubProbe({
    env: {
      [LIVE_STUB_ENV]: "http://127.0.0.1:8787/api/integrations/v1",
      [STUB_SERVICE_USER_ENV]: "svc",
      [STUB_SERVICE_PASSWORD_ENV]: "lab-secret",
      [STUB_GRANT_CREDENTIAL_ENV]: "grant-lab",
      [STUB_DIGITAL_HUMAN_ID_ENV]: "dh-live",
    },
    fetchImpl,
  });
  assert.equal(report.profile.state, "ok");
  if (report.profile.state === "ok") {
    assert.equal(report.profile.digitalHumanId, "dh-live");
  }
  assert.equal(profileHeaders?.get("authorization"), authorization);
  assert.equal(profileHeaders?.get(GRANT_CREDENTIAL_HEADER), "grant-lab");
  assert.equal(formatLiveStubReport(report).includes("lab-secret"), false);
  assert.equal(formatLiveStubReport(report).includes("grant-lab"), false);
});

test("live camera mode uploads the synthetic fixture and does not put the grant on the ticket", async () => {
  const control = new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => "042315",
    authorizationRef: () => "aref_live",
    token: () => "ctok_live",
  });
  control.redeemClaim("dev-live", control.issueClaim("dev-live").code);
  const binding = control.bind({
    deviceId: "dev-live",
    digitalHumanId: "dh-live",
    assistant: { voiceId: "voice-lab" },
  });
  const session = new LabCameraSession(control, { now: () => 1_700_000_000_000 });
  const server = await startLabMediaServer(session);
  const calls: { method: string; authorization: string | null; grant: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname.includes("/digital-humans/")) {
      return new Response(JSON.stringify({ digitalHumanId: "dh-live", assistant: { voiceId: "v" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      grant: headers.get(GRANT_CREDENTIAL_HEADER),
    });
    return fetch(input, init);
  };
  try {
    const report = await runLiveStubProbe({
      env: {
        [LIVE_STUB_ENV]: server.url,
        [STUB_SERVICE_USER_ENV]: "svc",
        [STUB_SERVICE_PASSWORD_ENV]: "lab-secret",
        [STUB_GRANT_CREDENTIAL_ENV]: "grant-lab",
        [STUB_DIGITAL_HUMAN_ID_ENV]: "dh-live",
        [STUB_AUTHORIZATION_REF_ENV]: binding.authorizationRef,
        [STUB_BINDING_VERSION_ENV]: String(binding.bindingVersion),
        [STUB_DEVICE_ID_ENV]: binding.deviceId,
      },
      fetchImpl,
      camera: true,
      now: () => 1_700_000_000_000,
    });
    assert.equal(report.camera.state, "ok");
    if (report.camera.state === "ok") {
      assert.equal(report.camera.contentType, "image/png");
      assert.equal(report.camera.width, 1);
      assert.equal(report.camera.height, 1);
      assert.equal(report.camera.checksum.length, 64);
    }
    const post = calls.filter((call) => call.method === "POST");
    const put = calls.filter((call) => call.method === "PUT");
    assert.equal(post.length, 2);
    assert.equal(put.length, 1);
    assert.equal(post.every((call) => call.authorization === basicAuthorization("svc", "lab-secret")), true);
    assert.equal(post.every((call) => call.grant === "grant-lab"), true);
    assert.equal(put[0]?.authorization, null);
    assert.equal(put[0]?.grant, null);
  } finally {
    await server.close();
  }
});

test("live-stub CLI prints the loopback usage and probes healthz", async () => {
  const help = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli, "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /OPENBOT_DEVICE_DH_STUB_URL=http:\/\/127\.0\.0\.1:8787/);
  assert.match(help.stdout, /\/healthz/);
  assert.equal(help.stdout.includes("api.tenclass.net"), false);

  const quiet = { ...process.env };
  delete quiet[LIVE_STUB_ENV];
  const skipped = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli], {
    cwd: root,
    encoding: "utf8",
    env: quiet,
  });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /未设置 OPENBOT_DEVICE_DH_STUB_URL/);

  const server = createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? 200 : 404);
    res.end("ok");
  });
  const origin = await listen(server);
  try {
    const probed = await runCliAsync([cli], { ...quiet, [LIVE_STUB_ENV]: origin });
    assert.equal(probed.status, 0, probed.stderr);
    assert.match(probed.stdout, new RegExp(`GET /healthz -> 200`));
    assert.match(probed.stdout, /routesAligned: true/);
    assert.match(probed.stdout, /firmwareUrl: null/);
    assert.match(probed.stdout, new RegExp(OPENBOT_CONTRACT_SHA));
  } finally {
    await close(server);
  }
});

test("prefixed stub URL still requests one integrations prefix", async () => {
  let seen = "";
  const fetchImpl: typeof fetch = async (input) => {
    seen = String(input);
    return new Response(JSON.stringify({ digitalHumanId: "dh", assistant: { voiceId: "v" } }), { status: 200 });
  };
  await readDigitalHuman("dh", {
    env: { [LIVE_STUB_ENV]: "http://127.0.0.1:9/api/integrations/v1" },
    fetchImpl,
  });
  assert.equal(seen, "http://127.0.0.1:9/api/integrations/v1/digital-humans/dh");
});

const liveUrl = process.env[LIVE_STUB_ENV];
const liveCreds = (() => {
  try {
    return serviceGrantHeaders(process.env);
  } catch {
    return undefined;
  }
})();

test(
  "live stub healthz",
  { skip: liveUrl ? false : "OPENBOT_DEVICE_DH_STUB_URL is unset" },
  async () => {
    const report = await runLiveStubProbe({ env: process.env });
    assert.equal(report.healthOk, true);
    assert.equal(report.healthPath, "/healthz");
    assert.equal(report.integrationsPrefix, "/api/integrations/v1");
  },
);

test(
  "live digital-human stub",
  { skip: liveUrl && liveCreds ? false : "stub URL or service/grant credentials are unset" },
  async () => {
    const id = process.env[STUB_DIGITAL_HUMAN_ID_ENV] ?? "dh-stub";
    const profile = await readDigitalHuman(id, { env: process.env });
    assert.equal(profile.digitalHumanId, id);
    assert.equal(typeof profile.assistant, "object");
  },
);

test(
  "live camera fixture against the stub",
  {
    skip:
      liveUrl && liveCreds && process.env[STUB_AUTHORIZATION_REF_ENV] && process.env[STUB_DEVICE_ID_ENV] && process.env[STUB_BINDING_VERSION_ENV]
        ? false
        : "stub URL, credentials, or camera binding fields are unset",
  },
  async () => {
    const report = await runLiveStubProbe({ env: process.env, camera: true });
    assert.equal(report.camera.state, "ok");
    if (report.camera.state === "ok") {
      assert.equal(report.camera.width, 1);
      assert.equal(report.camera.height, 1);
    }
  },
);
