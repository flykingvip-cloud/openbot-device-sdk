import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STAGING_CONTROL_SECTION = "control";

export const STAGING_SESSION_SECTION = "sessions";

const SECTIONS = new Set<string>([STAGING_CONTROL_SECTION, STAGING_SESSION_SECTION]);

export interface StagingDb {
  get(section: string): unknown;
  set(section: string, value: unknown): void;
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

/**
 * Process-local staging map. A second `ControlPlane` on the same instance
 * sees the last `set`, which is the in-process stand-in for a restart.
 */
export class MemoryStagingDb implements StagingDb {
  private readonly sections = new Map<string, unknown>();

  get(section: string): unknown {
    assertSection(section);
    const value = this.sections.get(section);
    return value === undefined ? undefined : structuredClone(value);
  }

  set(section: string, value: unknown): void {
    assertSection(section);
    this.sections.set(section, cloneSection(value));
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

  set(section: string, value: unknown): void {
    assertSection(section);
    const all = this.readAll();
    all[section] = cloneSection(value);
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
}

/**
 * SQLite staging for the lab console and simulator.
 * One row per section. `node:sqlite` is still marked experimental in Node 22;
 * the npm scripts disable that warning.
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

  set(section: string, value: unknown): void {
    assertSection(section);
    const body = JSON.stringify(cloneSection(value));
    this.db
      .prepare(
        `INSERT INTO staging_section (name, body) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET body = excluded.body`,
      )
      .run(section, body);
  }

  close(): void {
    this.db.close();
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
