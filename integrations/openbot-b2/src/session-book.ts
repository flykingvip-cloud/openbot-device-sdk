import { assertSessionId } from "../../../adapters/metalio/src/index.ts";
import {
  FrozenFieldError,
  assertFrozenBinding,
  assertNoFrozenAliases,
  assistantEqual,
  isPlainObject,
  type FrozenBinding,
} from "../../../contracts/src/index.ts";
import { STAGING_SESSION_SECTION, type StagingDb } from "../../../services/src/staging-db.ts";
import type { ControlPlane } from "../../../services/src/index.ts";

/** Lab stand-in cursor lifetime. Pulls at or after this instant return `CURSOR_EXPIRED`. */
export const SESSION_CURSOR_TTL_MS = 5 * 60 * 1000;

const SESSION_CAP = 100;
const EVENT_CAP = 100;
const STATE_VERSION = 1;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const EVENT_TYPE = /^[A-Za-z0-9._-]{1,64}$/;

export type SessionErrorCode = "SESSION_BUSY" | "CURSOR_EXPIRED" | "SESSION_NOT_FOUND" | "SESSION_CLOSED";

export type SessionCloseReason = "revoked" | "rebound" | "closed" | "expired";

export class SessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

export interface SessionRequest {
  authorizationRef: string;
  bindingVersion: number;
  digitalHumanId: string;
  deviceId: string;
  idempotencyKey?: string;
}

export interface DeviceSession {
  sessionId: string;
  binding: FrozenBinding;
  standIn: "B2";
}

export interface SessionEventInput {
  eventId: string;
  type: string;
}

export interface SessionEvent {
  eventId: string;
  sessionId: string;
  cursor: number;
  type: string;
}

export interface AppendSessionEventResult {
  accepted: boolean;
  duplicate: boolean;
  cursor: number;
  eventId: string;
}

export interface SessionPull {
  sessionId: string;
  events: SessionEvent[];
  cursorExpiresAtMs: number;
}

export interface SessionBookOptions {
  plane: ControlPlane;
  now?: () => number;
  sessionId?: () => string;
  store?: StagingDb;
  cursorTtlMs?: number;
}

export interface B2Options {
  plane: ControlPlane;
  sessionId?: () => string;
  now?: () => number;
  book?: SessionBook;
  store?: StagingDb;
}

interface PersistedSession {
  sessionId: string;
  deviceId: string;
  idempotencyKey: string | null;
  binding: FrozenBinding;
  openedAtMs: number;
  cursorExpiresAtMs: number;
  nextCursor: number;
  status: "open" | "closed";
  closeReason: SessionCloseReason | null;
}

interface SessionSection {
  version: typeof STATE_VERSION;
  sessions: PersistedSession[];
  events: SessionEvent[];
}

const books = new WeakMap<ControlPlane, SessionBook>();

export class SessionBook {
  private readonly plane: ControlPlane;
  private readonly store: StagingDb | undefined;
  private readonly cursorTtlMs: number;
  private readonly sessionId: () => string;
  private now: () => number;
  private nextFallback = 0;
  private readonly sessions = new Map<string, PersistedSession>();
  private readonly events: SessionEvent[] = [];

  constructor(options: SessionBookOptions) {
    this.plane = options.plane;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.cursorTtlMs = options.cursorTtlMs ?? SESSION_CURSOR_TTL_MS;
    const custom = options.sessionId;
    this.sessionId =
      custom ??
      (() => {
        this.nextFallback += 1;
        return `sess_${this.nextFallback}`;
      });
    if (this.store) {
      this.hydrate();
    }
    this.plane.attachSessionLifecycle(this);
  }

  useClock(now: () => number): void {
    this.now = now;
  }

  /**
   * Closes one session. A later append or pull does not enter this run.
   * Closing an already closed session is a no-op.
   */
  release(sessionId: string): { sessionId: string; released: true } {
    this.invalidate(sessionId);
    return { sessionId, released: true };
  }

  /** Force-closes one session. Revoke, rebind, expiry, and `release` all end here. */
  invalidate(sessionId: string): { sessionId: string; invalidated: true } {
    const session = this.requireSession(sessionId);
    if (session.status !== "closed") {
      this.closeSession(session, "closed");
      this.persist();
    }
    return { sessionId, invalidated: true };
  }

  /**
   * Closes every still-open session for the device.
   * `ControlPlane.revoke` and `rebind` call this so the old run cannot accept late events.
   */
  invalidateDevice(deviceId: string, reason: "revoked" | "rebound"): number {
    let closed = 0;
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId && session.status !== "closed") {
        this.closeSession(session, reason);
        closed += 1;
      }
    }
    if (closed > 0) {
      this.persist();
    }
    return closed;
  }

  open(request: SessionRequest): DeviceSession {
    assertNoFrozenAliases(request);
    const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
    const binding = this.requireMatchingBinding(request);
    this.sweepDevice(request.deviceId);
    if (this.plane.isRevoked(request.deviceId)) {
      throw new SessionError("SESSION_CLOSED", "device is revoked");
    }
    const active = [...this.sessions.values()].find(
      (session) => session.deviceId === request.deviceId && session.status !== "closed",
    );
    if (active) {
      if (
        idempotencyKey !== null &&
        active.idempotencyKey === idempotencyKey &&
        active.binding.authorizationRef === binding.authorizationRef &&
        active.binding.bindingVersion === binding.bindingVersion &&
        active.binding.digitalHumanId === binding.digitalHumanId
      ) {
        if (!assistantEqual(active.binding.assistant, binding.assistant)) {
          throw new FrozenFieldError("assistant");
        }
        return this.toDeviceSession(active);
      }
      throw new SessionError("SESSION_BUSY", "device already has an open session");
    }
    if (this.sessions.size >= SESSION_CAP) {
      throw new Error("session cap");
    }
    const sessionId = this.sessionId();
    assertSessionId(sessionId);
    if (this.sessions.has(sessionId)) {
      throw new Error("session id collided");
    }
    const now = this.now();
    const session: PersistedSession = {
      sessionId,
      deviceId: binding.deviceId,
      idempotencyKey,
      binding: structuredClone(binding),
      openedAtMs: now,
      cursorExpiresAtMs: now + this.cursorTtlMs,
      nextCursor: 1,
      status: "open",
      closeReason: null,
    };
    this.sessions.set(sessionId, session);
    this.persist();
    return this.toDeviceSession(session);
  }

  append(sessionId: string, event: SessionEventInput): AppendSessionEventResult {
    const session = this.requireSession(sessionId);
    this.assertUsable(session);
    if (!IDEMPOTENCY_KEY.test(event.eventId)) {
      throw new Error("eventId must match [A-Za-z0-9_.:-]{1,128}");
    }
    if (!EVENT_TYPE.test(event.type)) {
      throw new Error("event type must match [A-Za-z0-9._-]{1,64}");
    }
    const existing = this.events.find((item) => item.sessionId === sessionId && item.eventId === event.eventId);
    if (existing) {
      return { accepted: false, duplicate: true, cursor: existing.cursor, eventId: existing.eventId };
    }
    const owned = this.events.filter((item) => item.sessionId === sessionId).length;
    if (owned >= EVENT_CAP) {
      throw new Error("session event cap");
    }
    const cursor = session.nextCursor;
    session.nextCursor += 1;
    session.cursorExpiresAtMs = this.now() + this.cursorTtlMs;
    this.events.push({ eventId: event.eventId, sessionId, cursor, type: event.type });
    this.persist();
    return { accepted: true, duplicate: false, cursor, eventId: event.eventId };
  }

  pull(sessionId: string, afterCursor: number): SessionPull {
    const session = this.requireSession(sessionId);
    if (!Number.isInteger(afterCursor) || afterCursor < 0) {
      throw new Error("cursor must be a non-negative integer");
    }
    this.assertUsable(session);
    const events = this.events
      .filter((event) => event.sessionId === sessionId && event.cursor > afterCursor)
      .sort((left, right) => left.cursor - right.cursor)
      .map((event) => ({ ...event }));
    return { sessionId, events, cursorExpiresAtMs: session.cursorExpiresAtMs };
  }

  private requireMatchingBinding(request: SessionRequest): FrozenBinding {
    const binding = this.plane.getBinding(request.deviceId);
    if (!binding) {
      throw new Error("device is not bound");
    }
    if (
      binding.authorizationRef !== request.authorizationRef ||
      binding.bindingVersion !== request.bindingVersion ||
      binding.digitalHumanId !== request.digitalHumanId ||
      binding.deviceId !== request.deviceId
    ) {
      throw new Error("session request does not match the frozen binding");
    }
    return binding;
  }

  private requireSession(sessionId: string): PersistedSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionError("SESSION_NOT_FOUND", "session not found");
    }
    return session;
  }

  private sweepDevice(deviceId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.deviceId !== deviceId || session.status === "closed") {
        continue;
      }
      try {
        this.assertUsable(session);
      } catch (error) {
        if (!(error instanceof SessionError)) {
          throw error;
        }
      }
    }
  }

  /**
   * Resume, append, and pull all come through here.
   * A revoked device, a newer binding, an explicit close, or an expired cursor
   * closes the session before any new event is accepted.
   */
  private assertUsable(session: PersistedSession): void {
    if (session.status === "closed") {
      this.throwClosed(session);
    }
    if (this.plane.isRevoked(session.deviceId)) {
      this.closeSession(session, "revoked");
      this.persist();
      throw new SessionError("SESSION_CLOSED", "device is revoked");
    }
    const binding = this.plane.getBinding(session.deviceId);
    if (
      !binding ||
      binding.authorizationRef !== session.binding.authorizationRef ||
      binding.bindingVersion !== session.binding.bindingVersion ||
      binding.deviceId !== session.deviceId
    ) {
      this.closeSession(session, "rebound");
      this.persist();
      throw new SessionError("SESSION_CLOSED", "session binding is no longer current");
    }
    if (this.now() >= session.cursorExpiresAtMs) {
      this.closeSession(session, "expired");
      this.persist();
      throw new SessionError("CURSOR_EXPIRED", "session event cursor expired");
    }
  }

  private closeSession(session: PersistedSession, reason: SessionCloseReason): void {
    session.status = "closed";
    session.closeReason = reason;
  }

  private throwClosed(session: PersistedSession): never {
    if (session.closeReason === "expired") {
      throw new SessionError("CURSOR_EXPIRED", "session event cursor expired");
    }
    throw new SessionError("SESSION_CLOSED", "session is closed");
  }

  private toDeviceSession(session: PersistedSession): DeviceSession {
    return {
      sessionId: session.sessionId,
      binding: structuredClone(session.binding),
      standIn: "B2",
    };
  }

  private hydrate(): void {
    const raw = this.store?.get(STAGING_SESSION_SECTION);
    if (raw === undefined) {
      return;
    }
    const section = parseSessionSection(raw);
    this.sessions.clear();
    this.events.length = 0;
    for (const session of section.sessions) {
      this.sessions.set(session.sessionId, session);
    }
    this.events.push(...section.events);
  }

  private persist(): void {
    if (!this.store) {
      return;
    }
    const section: SessionSection = {
      version: STATE_VERSION,
      sessions: [...this.sessions.values()].map((session) => ({
        ...session,
        binding: structuredClone(session.binding),
      })),
      events: this.events.map((event) => ({ ...event })),
    };
    this.store.set(STAGING_SESSION_SECTION, section);
  }
}

function parseLifecycle(
  status: unknown,
  closeReason: unknown,
): { status: "open" | "closed"; closeReason: SessionCloseReason | null } {
  if (status === undefined || status === "open") {
    if (closeReason !== undefined && closeReason !== null) {
      throw new Error("session state corrupt");
    }
    return { status: "open", closeReason: null };
  }
  if (status !== "closed") {
    throw new Error("session state corrupt");
  }
  if (closeReason !== "revoked" && closeReason !== "rebound" && closeReason !== "closed" && closeReason !== "expired") {
    throw new Error("session state corrupt");
  }
  return { status: "closed", closeReason };
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new Error("idempotency key must match [A-Za-z0-9_.:-]{1,128}");
  }
  return value;
}

function bookFor(options: B2Options): SessionBook {
  if (options.book) {
    if (options.now) {
      options.book.useClock(options.now);
    }
    return options.book;
  }
  let book = books.get(options.plane);
  if (!book) {
    book = new SessionBook({
      plane: options.plane,
      ...(options.now ? { now: options.now } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.store ? { store: options.store } : {}),
    });
    books.set(options.plane, book);
  } else if (options.now) {
    book.useClock(options.now);
  }
  return book;
}

export function openDeviceSession(request: SessionRequest, options: B2Options): DeviceSession {
  return bookFor(options).open(request);
}

export function appendSessionEvent(
  sessionId: string,
  event: SessionEventInput,
  options: B2Options,
): AppendSessionEventResult {
  return bookFor(options).append(sessionId, event);
}

export function pullSessionEvents(sessionId: string, afterCursor: number, options: B2Options): SessionPull {
  return bookFor(options).pull(sessionId, afterCursor);
}

function parseSessionSection(raw: unknown): SessionSection {
  if (!isPlainObject(raw) || raw.version !== STATE_VERSION || !Array.isArray(raw.sessions) || !Array.isArray(raw.events)) {
    throw new Error("session state corrupt");
  }
  const sessions: PersistedSession[] = [];
  const seenSession = new Set<string>();
  const seenDevice = new Set<string>();
  for (const item of raw.sessions) {
    if (!isPlainObject(item)) {
      throw new Error("session state corrupt");
    }
    const binding = assertFrozenBinding(item.binding);
    const sessionId = item.sessionId;
    const deviceId = item.deviceId;
    const idempotencyKey = item.idempotencyKey;
    const openedAtMs = item.openedAtMs;
    const cursorExpiresAtMs = item.cursorExpiresAtMs;
    const nextCursor = item.nextCursor;
    if (typeof sessionId !== "string" || seenSession.has(sessionId)) {
      throw new Error("session state corrupt");
    }
    assertSessionId(sessionId);
    const lifecycle = parseLifecycle(item.status, item.closeReason);
    if (typeof deviceId !== "string" || deviceId !== binding.deviceId) {
      throw new Error("session state corrupt");
    }
    if (lifecycle.status === "open" && seenDevice.has(deviceId)) {
      throw new Error("session state corrupt");
    }
    let key: string | null;
    if (idempotencyKey === null) {
      key = null;
    } else if (typeof idempotencyKey === "string" && IDEMPOTENCY_KEY.test(idempotencyKey)) {
      key = idempotencyKey;
    } else {
      throw new Error("session state corrupt");
    }
    if (
      typeof openedAtMs !== "number" ||
      !Number.isFinite(openedAtMs) ||
      typeof cursorExpiresAtMs !== "number" ||
      !Number.isFinite(cursorExpiresAtMs) ||
      typeof nextCursor !== "number" ||
      !Number.isInteger(nextCursor) ||
      nextCursor < 1
    ) {
      throw new Error("session state corrupt");
    }
    seenSession.add(sessionId);
    if (lifecycle.status === "open") {
      seenDevice.add(deviceId);
    }
    sessions.push({
      sessionId,
      deviceId,
      idempotencyKey: key,
      binding,
      openedAtMs,
      cursorExpiresAtMs,
      nextCursor,
      status: lifecycle.status,
      closeReason: lifecycle.closeReason,
    });
  }
  const events: SessionEvent[] = [];
  const seenEvent = new Set<string>();
  const seenCursor = new Set<string>();
  for (const item of raw.events) {
    if (!isPlainObject(item)) {
      throw new Error("session state corrupt");
    }
    const { eventId, sessionId, cursor, type } = item;
    if (typeof eventId !== "string" || typeof sessionId !== "string" || typeof type !== "string") {
      throw new Error("session state corrupt");
    }
    if (!seenSession.has(sessionId) || !IDEMPOTENCY_KEY.test(eventId) || !EVENT_TYPE.test(type)) {
      throw new Error("session state corrupt");
    }
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 1) {
      throw new Error("session state corrupt");
    }
    const dedupeKey = `${sessionId}\n${eventId}`;
    const cursorKey = `${sessionId}\n${cursor}`;
    if (seenEvent.has(dedupeKey) || seenCursor.has(cursorKey)) {
      throw new Error("session state corrupt");
    }
    seenEvent.add(dedupeKey);
    seenCursor.add(cursorKey);
    events.push({ eventId, sessionId, cursor, type });
  }
  for (const session of sessions) {
    const maxCursor = events
      .filter((event) => event.sessionId === session.sessionId)
      .reduce((max, event) => Math.max(max, event.cursor), 0);
    if (session.nextCursor <= maxCursor) {
      throw new Error("session state corrupt");
    }
  }
  return { version: STATE_VERSION, sessions, events };
}
