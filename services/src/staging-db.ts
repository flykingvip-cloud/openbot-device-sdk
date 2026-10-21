import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STAGING_CONTROL_SECTION = "control";

export const STAGING_SESSION_SECTION = "sessions";

const SECTIONS = new Set<string>([STAGING_CONTROL_SECTION, STAGING_SESSION_SECTION]);

const FILE_REVISION_KEY = "__revisions";

export class StagingConflictError extends Error {
  readonly code = "staging_conflict";
  readonly section: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(section: string, expectedRevision: number, actualRevision: number) {
    super(
      `staging section ${section} revision conflict: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "StagingConflictError";
    this.section = section;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface StagingDb {
  get(section: string): unknown;
  /** Monotonic section revision. Absent sections are revision 0. */
  revision(section: string): number;
  /**
   * Persist a section. When `expectedRevision` is set, the write succeeds only if the
   * stored revision still matches (optimistic concurrency). Unconditional writes omit it.
   */
  set(section: string, value: unknown, expectedRevision?: number): void;
  close(): void;
}

function assertSection(section: string): void {
  if (!SECTIONS.has(section)) {
    throw new Error(`unknown staging section: ${section}`);
  }
}

function assertLocalPath(path: string): void {
  if (path.length === 0 || path.includes("://")) {
    throw new Error("staging path must be a local file");
  }
}

function cloneSection(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function asRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("staging revision must be a non-negative integer");
  }
  return value;
}

/**
 * Process-local staging map. A second `ControlPlane` on the same instance
 * sees the last `set`, which is the in-process stand-in for a restart.
 */
export class MemoryStagingDb implements StagingDb {
  private readonly sections = new Map<string, unknown>();
  private readonly revisions = new Map<string, number>();

  get(section: string): unknown {
    assertSection(section);
    const value = this.sections.get(section);
    return value === undefined ? undefined : structuredClone(value);
  }

  revision(section: string): number {
    assertSection(section);
    return this.revisions.get(section) ?? 0;
  }

  set(section: string, value: unknown, expectedRevision?: number): void {
    assertSection(section);
    const current = this.revisions.get(section) ?? 0;
    if (expectedRevision !== undefined && current !== expectedRevision) {
      throw new StagingConflictError(section, expectedRevision, current);
    }
    this.sections.set(section, cloneSection(value));
    this.revisions.set(section, current + 1);
  }

  close(): void {}
}

/** JSON file staging. Writes are replace-via-rename so a restart sees one complete file. */
export class FileStagingDb implements StagingDb {
  private readonly path: string;

  constructor(path: string) {
    assertLocalPath(path);
    this.path = path;
  }

  get(section: string): unknown {
    assertSection(section);
    return this.readAll()[section];
  }

  revision(section: string): number {
    assertSection(section);
    return this.readRevisionMap()[section] ?? 0;
  }

  set(section: string, value: unknown, expectedRevision?: number): void {
    assertSection(section);
    const all = this.readAll();
    const revisions = this.revisionMapFrom(all);
    const current = revisions[section] ?? 0;
    if (expectedRevision !== undefined && current !== expectedRevision) {
      throw new StagingConflictError(section, expectedRevision, current);
    }
    all[section] = cloneSection(value);
    revisions[section] = current + 1;
    all[FILE_REVISION_KEY] = revisions;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(temporary, this.path);
  }

  close(): void {}

  private readAll(): Record<string, unknown> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return {};
      }
      throw error;
    }
    if (text.trim().length === 0) {
      throw new Error("staging file is empty");
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("staging file must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  private readRevisionMap(): Record<string, number> {
    return this.revisionMapFrom(this.readAll());
  }

  private revisionMapFrom(all: Record<string, unknown>): Record<string, number> {
    const raw = all[FILE_REVISION_KEY];
    if (raw === undefined) {
      return {};
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("staging file revisions must be an object");
    }
    const out: Record<string, number> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!SECTIONS.has(name)) {
        continue;
      }
      out[name] = asRevision(value);
    }
    return out;
  }
}

/**
 * SQLite staging for the lab console and simulator.
 * One row per section. `node:sqlite` is still marked experimental in Node 22;
 * the npm scripts disable that warning.
 * Section `revision` supports optimistic concurrency across ControlPlane instances.
 */
export class SqliteStagingDb implements StagingDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    assertLocalPath(path);
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS staging_section (
        name TEXT PRIMARY KEY,
        body TEXT NOT NULL
      )
    `);
    this.ensureRevisionColumn();
  }

  get(section: string): unknown {
    assertSection(section);
    const row = this.db.prepare("SELECT body FROM staging_section WHERE name = ?").get(section);
    if (row === undefined) {
      return undefined;
    }
    const body = row.body;
    if (typeof body !== "string") {
      throw new Error(`staging section ${section} is not text`);
    }
    return JSON.parse(body) as unknown;
  }

  revision(section: string): number {
    assertSection(section);
    const row = this.db.prepare("SELECT revision FROM staging_section WHERE name = ?").get(section);
    if (row === undefined) {
      return 0;
    }
    return asRevision(row.revision);
  }

  set(section: string, value: unknown, expectedRevision?: number): void {
    assertSection(section);
    const body = JSON.stringify(cloneSection(value));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT revision FROM staging_section WHERE name = ?").get(section);
      const current = row === undefined ? 0 : asRevision(row.revision);
      if (expectedRevision !== undefined && current !== expectedRevision) {
        this.db.exec("ROLLBACK");
        throw new StagingConflictError(section, expectedRevision, current);
      }
      const nextRevision = current + 1;
      this.db
        .prepare(
          `INSERT INTO staging_section (name, body, revision) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET body = excluded.body, revision = excluded.revision`,
        )
        .run(section, body, nextRevision);
      this.db.exec("COMMIT");
    } catch (error) {
      if (!(error instanceof StagingConflictError)) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore rollback failures after a failed transaction
        }
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private ensureRevisionColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(staging_section)").all() as Array<{ name?: unknown }>;
    const hasRevision = columns.some((column) => column.name === "revision");
    if (!hasRevision) {
      this.db.exec("ALTER TABLE staging_section ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    }
  }
}

export function openStaging(path: string): StagingDb {
  if (path.endsWith(".json")) {
    return new FileStagingDb(path);
  }
  return new SqliteStagingDb(path);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
