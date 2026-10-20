import assert from "node:assert/strict";
import test from "node:test";

import { DeviceToolError } from "../sdk/src/device-tools.ts";
import { invokeOpenBotTool } from "../integrations/openbot-b3/src/index.ts";
import {
  LabMediaError,
  acceptToolRequest,
  runLabCameraCapture,
  startLabMediaServer,
  type CameraCaptureResult,
  type CameraToolRequest,
  type ToolResultBody,
  LabCameraSession,
} from "../integrations/openbot-media/src/index.ts";
import { ControlPlane, OtaDisabledError } from "../services/src/index.ts";

function plane(): ControlPlane {
  let refs = 0;
  return new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => "042315",
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
    token: () => "ctok_camera",
  });
}

function bound(control: ControlPlane): CameraToolRequest {
  control.redeemClaim("dev-cam", control.issueClaim("dev-cam").code);
  const binding = control.bind({
    deviceId: "dev-cam",
    digitalHumanId: "dh-cam",
    assistant: { voiceId: "voice-lab" },
  });
  return {
    requestId: "req-cam",
    authorizationRef: binding.authorizationRef,
    bindingVersion: binding.bindingVersion,
    deviceId: binding.deviceId,
    runId: "run-cam",
  };
}

test("lab camera capture uploads a fixture and posts MediaRef", () => {
  const control = plane();
  const request = bound(control);
  const session = new LabCameraSession(control, { now: () => 1_700_000_000_000 });
  const event = acceptToolRequest({ type: "tool.request", payload: { name: "camera.capture", ...request } });
  const captured = session.capture(event);
  assert.equal(captured.status, "ok");
  assert.equal(captured.duplicate, false);
  assert.equal(captured.result?.contentType, "image/png");
  assert.equal(captured.result?.width, 1);
  assert.equal(captured.result?.height, 1);
  assert.equal(typeof captured.result?.checksum, "string");
  assert.equal(captured.result?.checksum?.length, 64);
  assert.equal(captured.result?.readUrl.includes("tenclass"), false);
  assert.equal(captured.bindingVersion, 1);
  assert.equal(captured.authorizationRef, request.authorizationRef);
  const jpeg = session.capture({ ...request, requestId: "req-jpeg", contentType: "image/jpeg" });
  assert.equal(jpeg.status, "ok");
  assert.equal(jpeg.result?.contentType, "image/jpeg");
  assert.equal(jpeg.result?.width, 1);
  assert.equal(jpeg.result?.height, 1);
  assert.throws(() => acceptToolRequest({ type: "tool.request", payload: { name: "ota.flash", ...request } }), DeviceToolError);
  assert.throws(() => acceptToolRequest({ type: "tool.request", payload: { name: "system.reboot", ...request } }), DeviceToolError);
  assert.throws(() => control.flash(), (error: unknown) => error instanceof OtaDisabledError && error.code === "ota_disabled");
  assert.throws(() => control.massFlash(), (error: unknown) => error instanceof OtaDisabledError && error.code === "mass_flash");
});

test("revoke mid-flight and a later result are camera_revoked", () => {
  const control = plane();
  const request = bound(control);
  const session = new LabCameraSession(control, { now: () => 1_700_000_000_000 });
  const mid = session.capture(request, {
    afterTicket: () => {
      control.revoke(request.deviceId);
    },
  });
  assert.equal(mid.status, "denied");
  assert.equal(mid.errorCode, "LATE_RESULT");
  assert.equal(mid.authError, "AUTH_REVOKED");
  assert.equal(mid.cameraCode, "camera_revoked");
  assert.equal(mid.result, null);

  const late = session.submitResult(
    {
      requestId: "req-late",
      authorizationRef: request.authorizationRef,
      bindingVersion: request.bindingVersion,
      deviceId: request.deviceId,
      status: "ok",
    },
    "late-key",
  );
  assert.equal(late.status, "denied");
  assert.equal(late.cameraCode, "camera_revoked");
  assert.equal(late.authError, "AUTH_REVOKED");
  assert.equal(late.errorCode, "LATE_RESULT");
});

test("result idempotency replays the same body and conflicts on a different body", () => {
  const control = plane();
  const request = bound(control);
  const session = new LabCameraSession(control, { now: () => 1_700_000_000_000 });
  const captured = session.capture({ ...request, idempotencyKey: "cap-1" });
  assert.equal(captured.status, "ok");
  const body: ToolResultBody = {
    requestId: request.requestId,
    authorizationRef: request.authorizationRef,
    bindingVersion: request.bindingVersion,
    deviceId: request.deviceId,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    status: "ok",
    errorCode: null,
    result: captured.result,
  };
  const replay = session.submitResult(body, "cap-1");
  assert.equal(replay.duplicate, true);
  assert.equal(replay.result?.checksum, captured.result?.checksum);
  control.revoke(request.deviceId);
  const afterRevoke = session.submitResult(body, "cap-1");
  assert.equal(afterRevoke.duplicate, true);
  assert.equal(afterRevoke.cameraCode, null);
  assert.throws(
    () =>
      session.submitResult(
        { ...body, result: captured.result === null ? null : { ...captured.result, checksum: "different" } },
        "cap-1",
      ),
    (error: unknown) => error instanceof LabMediaError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("in-flight camera result replays the processing accept, then the final response", () => {
  const control = plane();
  const request = bound(control);
  const session = new LabCameraSession(control, { now: () => 1_700_000_000_000 });
  const captured = session.capture(request);
  const body: ToolResultBody = {
    requestId: "req-inflight",
    authorizationRef: request.authorizationRef,
    bindingVersion: request.bindingVersion,
    deviceId: request.deviceId,
    status: "ok",
    errorCode: null,
    result: captured.result,
  };
  let inflight: CameraCaptureResult | undefined;
  const finished = session.submitResult(body, "vision-1", {
    onProcessing: () => {
      inflight = session.submitResult(body, "vision-1");
      assert.throws(
        () => session.submitResult({ ...body, requestId: "req-other" }, "vision-1"),
        (error: unknown) => error instanceof LabMediaError && error.code === "IDEMPOTENCY_CONFLICT",
      );
    },
  });
  assert.equal(inflight?.duplicate, true);
  assert.equal(inflight?.inflight, true);
  assert.equal(inflight?.status, "processing");
  assert.equal(inflight?.result, null);
  assert.equal(finished.status, "ok");
  assert.equal(finished.duplicate, false);
  assert.equal(finished.inflight, undefined);
  const finalReplay = session.submitResult(body, "vision-1");
  assert.equal(finalReplay.duplicate, true);
  assert.equal(finalReplay.inflight, undefined);
  assert.equal(finalReplay.status, "ok");
  assert.equal(finalReplay.result?.checksum, captured.result?.checksum);
  assert.notEqual(finalReplay.errorCode, "LATE_RESULT");

  const closed = session.submitResult({ ...body, requestId: "req-close" }, "vision-close", {
    onProcessing: () => {
      session.cancel("req-close");
    },
  });
  assert.equal(closed.status, "cancelled");
  assert.equal(closed.result, null);
  const closedReplay = session.submitResult({ ...body, requestId: "req-close" }, "vision-close");
  assert.equal(closedReplay.duplicate, true);
  assert.equal(closedReplay.status, "cancelled");
  assert.notEqual(closedReplay.status, "ok");
});

test("cancel, busy, and timeout stop the lab capture before an ok result", () => {
  const control = plane();
  const request = bound(control);
  const session = new LabCameraSession(control, { now: () => 1_700_000_000_000 });
  const cancelled = session.capture(request, {
    afterTicket: () => {
      session.cancel(request.requestId);
    },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.errorCode, "CANCELLED");
  assert.equal(cancelled.result, null);

  const again = session.capture({ ...request, requestId: "req-busy" }, {
    afterTicket: () => {
      const busy = session.capture({ ...request, requestId: "req-other" });
      assert.equal(busy.status, "busy");
      assert.equal(busy.errorCode, "CAMERA_BUSY");
    },
  });
  assert.equal(again.status, "ok");

  const timed = session.capture({ ...request, requestId: "req-time", timeoutAtMs: 1_700_000_000_000 });
  assert.equal(timed.status, "timeout");
  assert.equal(timed.errorCode, "TIMEOUT");
});

test("B3 camera.capture uses the lab loop and still refuses flash", () => {
  const control = plane();
  const request = bound(control);
  const camera = new LabCameraSession(control, { now: () => 1_700_000_000_000 });
  const invocation = invokeOpenBotTool(
    "camera.capture",
    { payload: { requestId: request.requestId } },
    {
      camera,
      scope: {
        deviceId: request.deviceId,
        authorizationRef: request.authorizationRef,
        bindingVersion: request.bindingVersion,
      },
      plane: control,
    },
  );
  assert.equal(invocation.result.name, "camera.capture");
  if (invocation.result.name !== "camera.capture") {
    return;
  }
  assert.equal(invocation.result.capture.status, "ok");
  assert.equal(invocation.result.capture.result?.width, 1);
  assert.throws(() => invokeOpenBotTool("ota.flash"), /disabled/);
  assert.throws(() => invokeOpenBotTool("ota.massFlash"), /disabled/);
  assert.throws(() => invokeOpenBotTool("system.reboot"), /disabled/);
});

test("lab media HTTP stand-in serves the integrations upload paths", async () => {
  const control = plane();
  const request = bound(control);
  const session = new LabCameraSession(control, { now: () => 1_700_000_000_000 });
  const server = await startLabMediaServer(session);
  try {
    const captured = await runLabCameraCapture(session, { ...request, requestId: "req-http" }, { baseUrl: server.url });
    assert.equal(captured.status, "ok");
    assert.equal(captured.result?.contentType, "image/png");
    assert.equal(captured.result?.height, 1);
    assert.equal(captured.duplicate, false);
  } finally {
    await server.close();
  }
});
