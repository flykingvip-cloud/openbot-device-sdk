import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  DEVICE_EDGE_DEVICE_ID_HEADER,
  DEVICE_EDGE_GRANT_HEADER,
  LabDeviceEdgeAuthProxy,
  buildOpenBotServiceHeaders,
  createAssessingDeviceVerifier,
  createTokenMapDeviceVerifier,
} from "../adapters/voice/src/device-edge-auth.ts";
import { ControlPlane } from "../services/src/control-plane.ts";
import {
  DEVICE_EDGE_PROXY_PREFIX,
  createLabDeviceEdgeAuthProxyFromEnv,
  labSmokeServiceCredential,
  parseLabTokenMap,
  startDeviceEdgeAuthProxyServer,
} from "../services/src/device-edge-auth-proxy.ts";

const SERVICE = {
  authorization: "Basic c3ZjOnNlY3JldA==",
  grantCredential: "grant-xyz",
} as const;

test("buildOpenBotServiceHeaders attaches the three OpenBot headers", () => {
  const headers = buildOpenBotServiceHeaders(SERVICE, "dev-1");
  assert.equal(headers.Authorization, "Basic c3ZjOnNlY3JldA==");
  assert.equal(headers[DEVICE_EDGE_GRANT_HEADER], "grant-xyz");
  assert.equal(headers[DEVICE_EDGE_DEVICE_ID_HEADER], "dev-1");
});

test("bad device token authorize fails and must not be followed by upstream", async () => {
  let upstreamCalls = 0;
  const proxy = new LabDeviceEdgeAuthProxy({
    service: SERVICE,
    verifyDevice: createTokenMapDeviceVerifier({ "dev-1": "good-token" }),
  });
  const result = await proxy.authorize({ deviceId: "dev-1", deviceToken: "bad-token" });
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected failure");
  }
  assert.equal(result.status, 401);
  assert.equal(result.error, "device_unauthorized");
  // Caller contract: only forward when ok.
  if (result.ok) {
    upstreamCalls += 1;
  }
  assert.equal(upstreamCalls, 0);
});

test("good device token authorize returns all three service headers", async () => {
  const proxy = new LabDeviceEdgeAuthProxy({
    service: SERVICE,
    verifyDevice: createTokenMapDeviceVerifier(new Map([["dev-1", "good-token"]])),
  });
  const result = await proxy.authorize({ deviceId: "dev-1", deviceToken: "good-token" });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected success");
  }
  assert.equal(result.headers.Authorization, SERVICE.authorization);
  assert.equal(result.headers[DEVICE_EDGE_GRANT_HEADER], SERVICE.grantCredential);
  assert.equal(result.headers[DEVICE_EDGE_DEVICE_ID_HEADER], "dev-1");
});

test("HTTP proxy: bad token → 401 and zero upstream hits", async () => {
  let upstreamHits = 0;
  const upstream = createServer((req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ unexpected: true, auth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.off("error", reject);
      resolve();
    });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const proxy = new LabDeviceEdgeAuthProxy({
    service: SERVICE,
    verifyDevice: createTokenMapDeviceVerifier({ "dev-1": "good-token" }),
  });
  const listening = await startDeviceEdgeAuthProxyServer({
    host: "127.0.0.1",
    port: 0,
    proxy,
    upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}`,
  });

  try {
    const response = await fetch(`${listening.url}${DEVICE_EDGE_PROXY_PREFIX}/v1/echo`, {
      method: "GET",
      headers: {
        Authorization: "Bearer bad-token",
        "X-Device-Id": "dev-1",
      },
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "device_unauthorized");
    assert.equal(upstreamHits, 0);
  } finally {
    await listening.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("HTTP proxy: good token → upstream receives Basic + grant + X-Device-Id", async () => {
  let seen: Record<string, string | undefined> = {};
  const upstream = createServer((req, res) => {
    seen = {
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      grant:
        typeof req.headers["x-openbot-grant-credential"] === "string"
          ? req.headers["x-openbot-grant-credential"]
          : undefined,
      deviceId: typeof req.headers["x-device-id"] === "string" ? req.headers["x-device-id"] : undefined,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.off("error", reject);
      resolve();
    });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const proxy = new LabDeviceEdgeAuthProxy({
    service: SERVICE,
    verifyDevice: createTokenMapDeviceVerifier({ "dev-1": "good-token" }),
  });
  const listening = await startDeviceEdgeAuthProxyServer({
    host: "127.0.0.1",
    port: 0,
    proxy,
    upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}`,
  });

  try {
    const response = await fetch(`${listening.url}${DEVICE_EDGE_PROXY_PREFIX}/v1/echo`, {
      method: "POST",
      headers: {
        Authorization: "Bearer good-token",
        "X-Device-Id": "dev-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ping: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(seen.authorization, SERVICE.authorization);
    assert.equal(seen.grant, SERVICE.grantCredential);
    assert.equal(seen.deviceId, "dev-1");
  } finally {
    await listening.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("mock upstream mode records headers without echoing service Basic to device", async () => {
  const proxy = new LabDeviceEdgeAuthProxy({
    service: labSmokeServiceCredential(),
    verifyDevice: createTokenMapDeviceVerifier({ "dev-edge-lab": "ctok_edge_lab" }),
  });
  const listening = await startDeviceEdgeAuthProxyServer({
    host: "127.0.0.1",
    port: 0,
    proxy,
  });
  try {
    const response = await fetch(`${listening.url}${DEVICE_EDGE_PROXY_PREFIX}/ping`, {
      headers: {
        Authorization: "Bearer ctok_edge_lab",
        "X-Device-Id": "dev-edge-lab",
      },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok?: boolean;
      upstream?: {
        receivedAuthorization?: boolean;
        receivedGrant?: boolean;
        receivedDeviceId?: boolean;
      };
    };
    assert.equal(body.ok, true);
    assert.equal(body.upstream?.receivedAuthorization, true);
    assert.equal(body.upstream?.receivedGrant, true);
    assert.equal(body.upstream?.receivedDeviceId, true);
    const text = JSON.stringify(body);
    assert.equal(text.includes("lab-edge-secret"), false);
    assert.equal(text.includes("Basic "), false);
    const hit = listening.lastUpstreamHit();
    assert.ok(hit);
    assert.equal(hit.headers.Authorization?.startsWith("Basic "), true);
    assert.equal(hit.headers[DEVICE_EDGE_GRANT_HEADER], "lab-grant-credential");
  } finally {
    await listening.close();
  }
});

test("ControlPlane assess wiring verifies lab connection tokens", async () => {
  const plane = new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => "100001",
    authorizationRef: () => "aref_1",
    token: () => "ctok_plane",
  });
  plane.redeemClaim("dev-1", plane.issueClaim("dev-1").code);
  plane.bind({ deviceId: "dev-1", digitalHumanId: "dh-1", assistant: { voiceId: "v1" } });
  const issued = plane.issueConnectionCredential("dev-1");

  const proxy = new LabDeviceEdgeAuthProxy({
    service: SERVICE,
    verifyDevice: createAssessingDeviceVerifier(
      (deviceId, deviceToken) => plane.assessConnectionCredential(deviceId, deviceToken).ok,
    ),
  });
  assert.equal(await proxy.verifyDevice({ deviceId: "dev-1", deviceToken: "nope" }), false);
  assert.equal(await proxy.verifyDevice({ deviceId: "dev-1", deviceToken: issued.token }), true);
});

test("parseLabTokenMap and env factory", () => {
  const map = parseLabTokenMap("a:tok1,b:tok2");
  assert.equal(map.get("a"), "tok1");
  assert.equal(map.get("b"), "tok2");
  const fromEnv = createLabDeviceEdgeAuthProxyFromEnv({
    OPENBOT_DEVICE_EDGE_LAB_TOKENS: "dev-x:ctok_x",
    OPENBOT_STUB_SERVICE_USER: "u",
    OPENBOT_STUB_SERVICE_PASSWORD: "p",
    OPENBOT_STUB_GRANT_CREDENTIAL: "g",
  });
  assert.equal(fromEnv.verifyDevice({ deviceId: "dev-x", deviceToken: "ctok_x" }), true);
  assert.equal(fromEnv.verifyDevice({ deviceId: "dev-x", deviceToken: "no" }), false);
  const headers = fromEnv.openBotHeaders("dev-x");
  assert.equal(headers[DEVICE_EDGE_DEVICE_ID_HEADER], "dev-x");
  assert.equal(headers[DEVICE_EDGE_GRANT_HEADER], "g");
  assert.match(headers.Authorization ?? "", /^Basic /);
});

test("firmware examples must not embed platform service Basic", async () => {
  const { readFileSync, readdirSync, statSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const roots = ["examples"];
  if (existsSync("firmware")) {
    roots.push("firmware");
  }
  const forbidden = [
    /Authorization:\s*Basic\s+[A-Za-z0-9+/=]{8,}/,
    /OPENBOT_STUB_SERVICE_PASSWORD\s*=\s*[^.\s\n"']+/,
    /lab-edge-secret/,
  ];
  const files: string[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(md|sh|ts|json|c|h|txt|hpp|cpp)$/.test(name)) {
        files.push(path);
      }
    }
  }
  for (const root of roots) {
    walk(root);
  }
  assert.ok(files.length > 0, "expected at least one examples file");
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(content), false, `${file} matched ${pattern}`);
    }
  }
  // Lab smoke credential helper is edge-only; must not appear under examples/.
  const edgeSrc = readFileSync("services/src/device-edge-auth-proxy.ts", "utf8");
  assert.match(edgeSrc, /lab-edge-secret/);
});
