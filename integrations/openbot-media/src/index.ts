import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { INTEGRATIONS_API_PREFIX } from "../../../contracts/src/index.ts";
import { DISABLED_DEVICE_COMMANDS, DeviceToolError } from "../../../sdk/src/device-tools.ts";
import type { ControlPlane } from "../../../services/src/index.ts";

/** 1×1 PNG fixture. Not an OV2710 frame. */
export const LAB_PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 1×1 JPEG fixture. Not an OV2710 frame. */
export const LAB_JPEG_FIXTURE = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda000c03010002110311003f00fdfca28a2803ffd9",
  "hex",
);

export const LAB_MEDIA_CONTENT_TYPES = ["image/png", "image/jpeg"] as const;

export type LabMediaContentType = (typeof LAB_MEDIA_CONTENT_TYPES)[number];

const TICKET_PATH = `${INTEGRATIONS_API_PREFIX}/media/upload-tickets`;
const UPLOAD_PATH = `${INTEGRATIONS_API_PREFIX}/media/uploads/`;
const RESULT_PREFIX = `${INTEGRATIONS_API_PREFIX}/device-tool-requests/`;
const RESULT_SUFFIX = "/result";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const TICKET_TTL_MS = 15 * 60 * 1000;

export class LabMediaError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly cameraCode: "camera_revoked" | null;

  constructor(code: string, message: string, httpStatus: number, cameraCode: "camera_revoked" | null = null) {
    super(message);
    this.name = "LabMediaError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.cameraCode = cameraCode;
  }
}

export interface LabMediaRef {
  mediaId: string;
  contentType: LabMediaContentType;
  width: number;
  height: number;
  byteLength: number;
  checksum: string;
  readUrl: string;
  expiresAt: string;
}

export interface CameraToolRequest {
  requestId: string;
  authorizationRef: string;
  bindingVersion: number;
  deviceId: string;
  runId?: string;
  contentType?: LabMediaContentType;
  idempotencyKey?: string;
  timeoutAtMs?: number;
}

export interface CameraCaptureResult {
  requestId: string;
  authorizationRef: string;
  bindingVersion: number;
  deviceId: string;
  status: "ok" | "denied" | "cancelled" | "busy" | "timeout" | "failed";
  errorCode: string | null;
  authError: "AUTH_REVOKED" | null;
  cameraCode: "camera_revoked" | null;
  duplicate: boolean;
  result: LabMediaRef | null;
}

export interface ToolResultBody {
  requestId: string;
  authorizationRef: string;
  bindingVersion: number;
  deviceId: string;
  runId?: string;
  status: CameraCaptureResult["status"];
  errorCode?: string | null;
  result?: LabMediaRef | null;
}

interface TicketRecord {
  ticket: string;
  mediaId: string;
  requestId: string;
  bindingVersion: number;
  deviceId: string;
  authorizationRef: string;
  contentType: LabMediaContentType;
  expiresAtMs: number;
  stored: StoredImage | null;
}

interface StoredImage {
  bytes: Buffer;
  width: number;
  height: number;
  checksum: string;
}

interface IdempotencyHit {
  digest: string;
  result: CameraCaptureResult;
}

export interface LabCameraHooks {
  afterTicket?: () => void;
}

export function labCameraFixture(contentType: LabMediaContentType): Buffer {
  return contentType === "image/jpeg" ? Buffer.from(LAB_JPEG_FIXTURE) : Buffer.from(LAB_PNG_FIXTURE);
}

export function acceptToolRequest(event: unknown): CameraToolRequest {
  if (typeof event !== "object" || event === null) {
    throw new LabMediaError("tool_request", "tool.request payload is missing", 400);
  }
  const record = event as Record<string, unknown>;
  if (record.type !== "tool.request") {
    throw new LabMediaError("tool_request", "event type must be tool.request", 400);
  }
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new LabMediaError("tool_request", "tool.request payload is missing", 400);
  }
  const body = payload as Record<string, unknown>;
  const name = body.name;
  if (typeof name !== "string") {
    throw new LabMediaError("tool_request", "tool name is required", 400);
  }
  if ((DISABLED_DEVICE_COMMANDS as readonly string[]).includes(name)) {
    throw new DeviceToolError("disabled_command", `${name} is not executable; production OTA, mass flash, and remote reboot are disabled`);
  }
  if (name !== "camera.capture") {
    throw new LabMediaError("unsupported", `lab camera loop only accepts camera.capture, got ${name}`, 400);
  }
  const requestId = requireText(body.requestId, "requestId");
  const authorizationRef = requireText(body.authorizationRef, "authorizationRef");
  const deviceId = requireText(body.deviceId, "deviceId");
  if (typeof body.bindingVersion !== "number" || !Number.isInteger(body.bindingVersion)) {
    throw new LabMediaError("BINDING_MISMATCH", "bindingVersion is required", 400);
  }
  const request: CameraToolRequest = {
    requestId,
    authorizationRef,
    bindingVersion: body.bindingVersion,
    deviceId,
  };
  if (typeof body.runId === "string") {
    request.runId = body.runId;
  }
  return request;
}

/**
 * Lab camera/media stand-in for `/api/integrations/v1` upload tickets,
 * ticket PUT, and device-tool result. It does not talk to a camera sensor.
 */
export class LabCameraSession {
  private readonly plane: ControlPlane;
  private readonly now: () => number;
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly idempotency = new Map<string, IdempotencyHit>();
  private readonly cancelled = new Set<string>();
  private readonly busy = new Set<string>();
  private ticketSerial = 0;

  constructor(plane: ControlPlane, options: { now?: () => number } = {}) {
    this.plane = plane;
    this.now = options.now ?? Date.now;
  }

  capture(request: CameraToolRequest, hooks: LabCameraHooks = {}): CameraCaptureResult {
    const refused = this.refusal(request);
    if (refused) {
      return refused;
    }
    if (this.busy.has(request.deviceId)) {
      return this.terminal(request, "busy", "CAMERA_BUSY");
    }
    this.busy.add(request.deviceId);
    try {
      const contentType = request.contentType ?? "image/png";
      const ticket = this.issueTicket(request, contentType);
      hooks.afterTicket?.();
      const mid = this.refusal(request);
      if (mid) {
        return mid;
      }
      const image = this.putUpload(ticket.ticket, labCameraFixture(contentType), contentType);
      const late = this.refusal(request);
      if (late) {
        return late;
      }
      const result = this.mediaRef(ticket, image, contentType);
      return this.submitResult(this.okBody(request, result), request.idempotencyKey);
    } finally {
      this.busy.delete(request.deviceId);
    }
  }

  cancel(requestId: string): void {
    this.cancelled.add(requestId);
  }

  submitResult(body: ToolResultBody, idempotencyKey?: string): CameraCaptureResult {
    const digest = resultDigest(body);
    if (idempotencyKey !== undefined) {
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new LabMediaError("idempotency_key", "Idempotency-Key is invalid", 400);
      }
      const existing = this.idempotency.get(idempotencyKey);
      if (existing) {
        if (existing.digest !== digest) {
          throw new LabMediaError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different result", 409);
        }
        return { ...structuredClone(existing.result), duplicate: true };
      }
    }
    const request = bodyToRequest(body);
    const refused = this.refusal(request);
    if (refused) {
      return refused;
    }
    if (body.status === "ok") {
      if (!body.result) {
        throw new LabMediaError("MEDIA_INVALID", "ok result requires MediaRef", 400);
      }
      const stored = [...this.tickets.values()].find((ticket) => ticket.mediaId === body.result?.mediaId);
      if (!stored?.stored || stored.stored.checksum !== body.result.checksum) {
        throw new LabMediaError("MEDIA_INVALID", "MediaRef does not match an uploaded fixture", 400);
      }
    }
    const accepted: CameraCaptureResult = {
      requestId: body.requestId,
      authorizationRef: body.authorizationRef,
      bindingVersion: body.bindingVersion,
      deviceId: body.deviceId,
      status: body.status,
      errorCode: body.errorCode ?? null,
      authError: null,
      cameraCode: null,
      duplicate: false,
      result: body.result ?? null,
    };
    if (idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, { digest, result: structuredClone(accepted) });
    }
    return accepted;
  }

  handle(input: {
    method: string;
    path: string;
    json?: unknown;
    bytes?: Buffer;
    contentType?: string;
    idempotencyKey?: string;
  }): { status: number; body: unknown } {
    try {
      if (input.method === "POST" && input.path === TICKET_PATH) {
        const record = asRecord(input.json);
        const request = acceptTicketBody(record);
        const contentType = request.contentType ?? "image/png";
        const ticket = this.issueTicket(request, contentType);
        return { status: 201, body: ticket };
      }
      if (input.method === "PUT" && input.path.startsWith(UPLOAD_PATH)) {
        const ticket = decodeURIComponent(input.path.slice(UPLOAD_PATH.length));
        const contentType = input.contentType === "image/jpeg" ? "image/jpeg" : "image/png";
        const image = this.putUpload(ticket, input.bytes ?? Buffer.alloc(0), contentType);
        return {
          status: 200,
          body: { accepted: true, width: image.width, height: image.height, byteLength: image.bytes.length, checksum: image.checksum },
        };
      }
      if (input.method === "POST" && input.path.startsWith(RESULT_PREFIX) && input.path.endsWith(RESULT_SUFFIX)) {
        const requestId = decodeURIComponent(input.path.slice(RESULT_PREFIX.length, -RESULT_SUFFIX.length));
        const body = acceptResultBody(input.json, requestId);
        return { status: 200, body: this.submitResult(body, input.idempotencyKey) };
      }
      return { status: 404, body: { error: { code: "OBJECT_NOT_FOUND", message: "lab media path not found", retryable: false } } };
    } catch (error) {
      if (error instanceof LabMediaError) {
        return {
          status: error.httpStatus,
          body: {
            error: { code: error.code, message: error.message, retryable: false },
            cameraCode: error.cameraCode,
          },
        };
      }
      throw error;
    }
  }

  private issueTicket(request: CameraToolRequest, contentType: LabMediaContentType): {
    mediaId: string;
    ticket: string;
    uploadPath: string;
    method: "PUT";
    expiresAt: string;
  } {
    this.assertBound(request);
    this.ticketSerial += 1;
    const ticket = `ticket_${this.ticketSerial}`;
    const mediaId = `media_${this.ticketSerial}`;
    const expiresAtMs = this.now() + TICKET_TTL_MS;
    this.tickets.set(ticket, {
      ticket,
      mediaId,
      requestId: request.requestId,
      bindingVersion: request.bindingVersion,
      deviceId: request.deviceId,
      authorizationRef: request.authorizationRef,
      contentType,
      expiresAtMs,
      stored: null,
    });
    return {
      mediaId,
      ticket,
      uploadPath: `${UPLOAD_PATH}${encodeURIComponent(ticket)}`,
      method: "PUT",
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  private putUpload(ticketId: string, bytes: Buffer, contentType: LabMediaContentType): StoredImage {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new LabMediaError("OBJECT_NOT_FOUND", "upload ticket was not issued", 404);
    }
    if (this.now() >= ticket.expiresAtMs) {
      throw new LabMediaError("TIMEOUT", "upload ticket expired", 400);
    }
    if (ticket.contentType !== contentType) {
      throw new LabMediaError("MEDIA_INVALID", "upload content type does not match the ticket", 400);
    }
    const image = inspectFixture(bytes, contentType);
    ticket.stored = image;
    return image;
  }

  private refusal(request: CameraToolRequest): CameraCaptureResult | undefined {
    if (request.timeoutAtMs !== undefined && this.now() >= request.timeoutAtMs) {
      return this.terminal(request, "timeout", "TIMEOUT");
    }
    if (this.cancelled.has(request.requestId)) {
      return this.terminal(request, "cancelled", "CANCELLED");
    }
    if (this.plane.isRevoked(request.deviceId)) {
      return {
        ...this.terminal(request, "denied", "LATE_RESULT"),
        authError: "AUTH_REVOKED",
        cameraCode: "camera_revoked",
      };
    }
    try {
      this.assertBound(request);
    } catch (error) {
      if (error instanceof LabMediaError && error.code === "BINDING_MISMATCH") {
        return this.terminal(request, "failed", "BINDING_MISMATCH");
      }
      throw error;
    }
    return undefined;
  }

  private assertBound(request: CameraToolRequest): void {
    const binding = this.plane.getBinding(request.deviceId);
    if (
      !binding ||
      binding.authorizationRef !== request.authorizationRef ||
      binding.bindingVersion !== request.bindingVersion ||
      binding.deviceId !== request.deviceId
    ) {
      throw new LabMediaError("BINDING_MISMATCH", "camera request does not match the current binding", 409);
    }
  }

  private terminal(
    request: CameraToolRequest,
    status: CameraCaptureResult["status"],
    errorCode: string,
  ): CameraCaptureResult {
    return {
      requestId: request.requestId,
      authorizationRef: request.authorizationRef,
      bindingVersion: request.bindingVersion,
      deviceId: request.deviceId,
      status,
      errorCode,
      authError: null,
      cameraCode: null,
      duplicate: false,
      result: null,
    };
  }

  private okBody(request: CameraToolRequest, result: LabMediaRef): ToolResultBody {
    return {
      requestId: request.requestId,
      authorizationRef: request.authorizationRef,
      bindingVersion: request.bindingVersion,
      deviceId: request.deviceId,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      status: "ok",
      errorCode: null,
      result,
    };
  }

  private mediaRef(ticket: { mediaId: string; ticket: string; expiresAt: string }, image: StoredImage, contentType: LabMediaContentType): LabMediaRef {
    return {
      mediaId: ticket.mediaId,
      contentType,
      width: image.width,
      height: image.height,
      byteLength: image.bytes.length,
      checksum: image.checksum,
      readUrl: `http://127.0.0.1/lab-media/${ticket.mediaId}`,
      expiresAt: ticket.expiresAt,
    };
  }
}

export async function runLabCameraCapture(
  session: LabCameraSession,
  request: CameraToolRequest,
  options: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    hooks?: LabCameraHooks;
    /** Service Basic and grant credential. Applied to the ticket and result POSTs, not the ticket PUT. */
    headers?: Record<string, string>;
  },
): Promise<CameraCaptureResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const authHeaders = options.headers ?? {};
  const contentType = request.contentType ?? "image/png";
  const ticketResponse = await fetchImpl(`${base}${TICKET_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({
      requestId: request.requestId,
      bindingVersion: request.bindingVersion,
      contentType,
      authorizationRef: request.authorizationRef,
      deviceId: request.deviceId,
    }),
  });
  if (!ticketResponse.ok) {
    throw new LabMediaError("upload_ticket", `upload ticket failed: ${ticketResponse.status}`, ticketResponse.status);
  }
  const ticket = (await ticketResponse.json()) as { ticket: string; mediaId: string; uploadPath: string; expiresAt: string };
  options.hooks?.afterTicket?.();
  const bytes = labCameraFixture(contentType);
  const upload = await fetchImpl(resolveTicketUploadUrl(base, ticket.uploadPath), {
    method: "PUT",
    headers: { "content-type": contentType },
    body: new Uint8Array(bytes),
  });
  if (!upload.ok) {
    throw new LabMediaError("MEDIA_INVALID", `upload failed: ${upload.status}`, upload.status);
  }
  const stored = (await upload.json()) as { checksum: string; width: number; height: number; byteLength: number };
  const result: LabMediaRef = {
    mediaId: ticket.mediaId,
    contentType,
    width: stored.width,
    height: stored.height,
    byteLength: stored.byteLength,
    checksum: stored.checksum,
    readUrl: `http://127.0.0.1/lab-media/${ticket.mediaId}`,
    expiresAt: ticket.expiresAt,
  };
  const posted = await fetchImpl(`${base}${RESULT_PREFIX}${encodeURIComponent(request.requestId)}${RESULT_SUFFIX}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
      ...(request.idempotencyKey === undefined ? {} : { "Idempotency-Key": request.idempotencyKey }),
    },
    body: JSON.stringify({
      requestId: request.requestId,
      authorizationRef: request.authorizationRef,
      bindingVersion: request.bindingVersion,
      deviceId: request.deviceId,
      status: "ok",
      result,
    }),
  });
  const payload = (await posted.json()) as CameraCaptureResult | { error: { code: string; message: string }; cameraCode: "camera_revoked" | null };
  if (!posted.ok) {
    const error = payload as { error: { code: string; message: string }; cameraCode: "camera_revoked" | null };
    throw new LabMediaError(error.error.code, error.error.message, posted.status, error.cameraCode);
  }
  return payload as CameraCaptureResult;
}

export function startLabMediaServer(
  session: LabCameraSession,
  options: { host?: string; port?: number } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void readRaw(req).then((bytes) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined;
      const idempotencyKey = headerValue(req, "idempotency-key");
      let json: unknown;
      if (contentType?.startsWith("application/json")) {
        json = bytes.length === 0 ? undefined : JSON.parse(bytes.toString("utf8"));
      }
      const outcome = session.handle({
        method: req.method ?? "GET",
        path: url.pathname,
        ...(json === undefined ? {} : { json }),
        ...(contentType?.startsWith("image/") ? { bytes, contentType } : {}),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      writeJson(res, outcome.status, outcome.body);
    }).catch(() => {
      writeJson(res, 400, { error: { code: "MEDIA_INVALID", message: "request body was not readable", retryable: false } });
    });
  });
  return listen(server, host, options.port ?? 0);
}

function resolveTicketUploadUrl(base: string, uploadPath: string): string {
  if (uploadPath.startsWith("https://") || uploadPath.startsWith("http://")) {
    let url: URL;
    try {
      url = new URL(uploadPath);
    } catch {
      throw new LabMediaError("MEDIA_INVALID", "upload path is not a URL", 400);
    }
    const host = url.hostname.toLowerCase();
    if (host.includes("tenclass") || (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")) {
      throw new LabMediaError("MEDIA_INVALID", "upload ticket host is not loopback", 400);
    }
    return url.toString();
  }
  if (!uploadPath.startsWith("/")) {
    throw new LabMediaError("MEDIA_INVALID", "upload path must be absolute", 400);
  }
  return `${base}${uploadPath}`;
}

function inspectFixture(bytes: Buffer, contentType: LabMediaContentType): StoredImage {
  const size = contentType === "image/png" ? readPngSize(bytes) : readJpegSize(bytes);
  if (!size) {
    throw new LabMediaError("MEDIA_INVALID", "upload is not a PNG or JPEG fixture", 400);
  }
  return {
    bytes: Buffer.from(bytes),
    width: size.width,
    height: size.height,
    checksum: createHash("sha256").update(bytes).digest("hex"),
  };
}

function readPngSize(bytes: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.subarray(12, 16).toString("utf8") !== "IHDR") {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readJpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) {
      return undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

function resultDigest(body: ToolResultBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function bodyToRequest(body: ToolResultBody): CameraToolRequest {
  const request: CameraToolRequest = {
    requestId: body.requestId,
    authorizationRef: body.authorizationRef,
    bindingVersion: body.bindingVersion,
    deviceId: body.deviceId,
  };
  if (body.runId !== undefined) {
    request.runId = body.runId;
  }
  return request;
}

function acceptTicketBody(record: Record<string, unknown>): CameraToolRequest {
  if (typeof record.bindingVersion !== "number") {
    throw new LabMediaError("BINDING_MISMATCH", "bindingVersion is required", 400);
  }
  const request: CameraToolRequest = {
    requestId: requireText(record.requestId, "requestId"),
    authorizationRef: requireText(record.authorizationRef, "authorizationRef"),
    bindingVersion: record.bindingVersion,
    deviceId: requireText(record.deviceId, "deviceId"),
  };
  if (record.contentType === "image/jpeg" || record.contentType === "image/png") {
    request.contentType = record.contentType;
  }
  return request;
}

function acceptResultBody(value: unknown, requestId: string): ToolResultBody {
  const record = asRecord(value);
  if (record.requestId !== requestId) {
    throw new LabMediaError("tool_request", "result requestId does not match the path", 400);
  }
  if (typeof record.bindingVersion !== "number" || typeof record.status !== "string") {
    throw new LabMediaError("tool_request", "result bindingVersion and status are required", 400);
  }
  const body: ToolResultBody = {
    requestId,
    authorizationRef: requireText(record.authorizationRef, "authorizationRef"),
    bindingVersion: record.bindingVersion,
    deviceId: requireText(record.deviceId, "deviceId"),
    status: record.status as CameraCaptureResult["status"],
  };
  if (typeof record.runId === "string") {
    body.runId = record.runId;
  }
  if (record.result !== undefined && record.result !== null) {
    body.result = record.result as LabMediaRef;
  }
  return body;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LabMediaError("tool_request", `${name} is required`, 400);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new LabMediaError("tool_request", "JSON object is required", 400);
  }
  return value as Record<string, unknown>;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function listen(server: Server, host: string, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("lab media server has no port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
