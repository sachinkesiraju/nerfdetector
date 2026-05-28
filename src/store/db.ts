import Database from "better-sqlite3";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NERFDETECTOR_DIR = join(homedir(), ".nerfdetector");
const DB_PATH = join(NERFDETECTOR_DIR, "events.db");

// Ordered list of migrations. Index = target user_version.
// migrations[0] is bootstrap; do not change historical entries.
const MIGRATIONS: string[][] = [
  // v1 — initial schema
  [
    `CREATE TABLE IF NOT EXISTS events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ts INTEGER NOT NULL,
       tool TEXT NOT NULL,
       model TEXT NOT NULL,
       event_type TEXT NOT NULL,
       duration_ms INTEGER,
       status TEXT,
       tool_ok INTEGER
     )`,
    `CREATE INDEX IF NOT EXISTS events_ts ON events (ts DESC)`,
    `CREATE TABLE IF NOT EXISTS baselines (
       model TEXT NOT NULL,
       metric TEXT NOT NULL,
       avg_7d REAL,
       avg_30d REAL,
       sample_count INTEGER DEFAULT 0,
       updated_at INTEGER,
       PRIMARY KEY (model, metric)
     )`,
  ],
  // v2 — tool name + response size + session id (was previously ad-hoc ALTERs)
  [
    `ALTER TABLE events ADD COLUMN tool_name TEXT`,
    `ALTER TABLE events ADD COLUMN response_size INTEGER`,
    `ALTER TABLE events ADD COLUMN session_id TEXT`,
    `CREATE INDEX IF NOT EXISTS events_session ON events (session_id)`,
  ],
  // v3 — ingest source tracking + de-dup for backfill
  [
    `ALTER TABLE events ADD COLUMN source TEXT`,
    `ALTER TABLE events ADD COLUMN source_offset INTEGER`,
    `CREATE UNIQUE INDEX IF NOT EXISTS events_dedup
       ON events (session_id, source, source_offset)
       WHERE source IS NOT NULL AND source_offset IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS file_cursors (
       path TEXT PRIMARY KEY,
       offset INTEGER NOT NULL,
       mtime_ms INTEGER NOT NULL,
       last_model TEXT,
       last_session_id TEXT,
       updated_at INTEGER NOT NULL
     )`,
  ],
  // v4 — fingerprint storage on vote events + user preference flags
  [
    `ALTER TABLE events ADD COLUMN fingerprint TEXT`,
    `CREATE TABLE IF NOT EXISTS prefs (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ],
  // v5 — token usage + tool_input hash (for context-waste detection)
  [
    `ALTER TABLE events ADD COLUMN input_tokens INTEGER`,
    `ALTER TABLE events ADD COLUMN output_tokens INTEGER`,
    `ALTER TABLE events ADD COLUMN cache_read_tokens INTEGER`,
    `ALTER TABLE events ADD COLUMN tool_input_hash TEXT`,
  ],
];

const CURRENT_VERSION = MIGRATIONS.length;

let _db: Database.Database | null = null;

export function getDataDir(): string {
  return NERFDETECTOR_DIR;
}

function runMigrations(db: Database.Database) {
  const cur = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (cur >= CURRENT_VERSION) return;

  for (let v = cur; v < CURRENT_VERSION; v++) {
    const steps = MIGRATIONS[v];
    db.exec("BEGIN");
    try {
      for (const sql of steps) {
        try {
          db.exec(sql);
        } catch (err: any) {
          // Tolerate "duplicate column" — happens on DBs migrated by the legacy ad-hoc ALTER chain
          if (!/duplicate column name/i.test(err.message ?? "")) throw err;
        }
      }
      db.pragma(`user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(NERFDETECTOR_DIR)) {
    mkdirSync(NERFDETECTOR_DIR, { recursive: true, mode: 0o700 });
  }

  try {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    runMigrations(_db);
  } catch {
    try { _db?.close(); } catch {}
    _db = null;
    try { unlinkSync(DB_PATH); } catch {}
    try { unlinkSync(DB_PATH + "-wal"); } catch {}
    try { unlinkSync(DB_PATH + "-shm"); } catch {}

    try {
      _db = new Database(DB_PATH);
      _db.pragma("journal_mode = WAL");
      runMigrations(_db);
    } catch {
      _db = null;
      throw new Error("nerfdetector: could not create database");
    }
  }

  return _db;
}

export function getSchemaVersion(): number {
  return (getDb().pragma("user_version", { simple: true }) as number) ?? 0;
}

process.on("exit", () => { try { _db?.close(); } catch {} });

export interface EventRow {
  id: number;
  ts: number;
  tool: string;
  model: string;
  event_type: string;
  duration_ms: number | null;
  status: string | null;
  tool_ok: number | null;
  tool_name: string | null;
  response_size: number | null;
  session_id: string | null;
  source: string | null;
  source_offset: number | null;
  fingerprint: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  tool_input_hash: string | null;
}

const VALID_TOOLS = new Set(["claude-code", "codex", "gemini", "local"]);
const VALID_SOURCES = new Set(["hook", "backfill"]);

export function insertEvent(
  tool: string,
  model: string,
  eventType: string,
  opts?: {
    durationMs?: number;
    status?: string;
    toolOk?: boolean;
    toolName?: string;
    responseSize?: number;
    sessionId?: string;
    source?: string;
    sourceOffset?: number;
    fingerprint?: string;
    ts?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    toolInputHash?: string;
  }
): number | null {
  if (!VALID_TOOLS.has(tool)) return null;
  if (model.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(model)) return null;

  const o = opts ?? {};
  const source = o.source && VALID_SOURCES.has(o.source) ? o.source : null;
  const db = getDb();

  try {
    const r = db.prepare(
      `INSERT INTO events
         (ts, tool, model, event_type, duration_ms, status, tool_ok, tool_name,
          response_size, session_id, source, source_offset, fingerprint,
          input_tokens, output_tokens, cache_read_tokens, tool_input_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      o.ts ?? Date.now(), tool, model, eventType,
      o.durationMs ?? null,
      o.status ?? null,
      o.toolOk != null ? (o.toolOk ? 1 : 0) : null,
      o.toolName ?? null,
      o.responseSize ?? null,
      o.sessionId ?? null,
      source,
      o.sourceOffset ?? null,
      o.fingerprint ?? null,
      o.inputTokens ?? null,
      o.outputTokens ?? null,
      o.cacheReadTokens ?? null,
      o.toolInputHash ?? null,
    );
    return Number(r.lastInsertRowid);
  } catch (err: any) {
    // De-dup hit on UNIQUE(session_id, source, source_offset) is expected during backfill
    if (/UNIQUE constraint/i.test(err.message ?? "")) return null;
    throw err;
  }
}

export function getRecentEvents(windowMs: number = 15 * 60 * 1000): EventRow[] {
  const db = getDb();
  const cutoff = Date.now() - windowMs;
  return db.prepare(`SELECT * FROM events WHERE ts > ? ORDER BY ts DESC`).all(cutoff) as EventRow[];
}

export function getEventsInRange(fromMs: number, toMs: number): EventRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM events WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`).all(fromMs, toMs) as EventRow[];
}

export function getEventsForSession(sessionId: string): EventRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY ts ASC`).all(sessionId) as EventRow[];
}

export function listRecentSessions(limit: number = 20): Array<{
  session_id: string;
  model: string;
  started_at: number;
  ended_at: number;
  event_count: number;
  vote: string | null;
}> {
  const db = getDb();
  return db.prepare(`
    SELECT
      session_id,
      (SELECT model FROM events e2
        WHERE e2.session_id = e1.session_id AND e2.model != 'unknown'
        ORDER BY ts DESC LIMIT 1) AS model,
      MIN(ts) AS started_at,
      MAX(ts) AS ended_at,
      COUNT(*) AS event_count,
      (SELECT status FROM events e3
        WHERE e3.session_id = e1.session_id AND e3.event_type = 'vote'
        ORDER BY ts DESC LIMIT 1) AS vote
    FROM events e1
    WHERE session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(limit) as any;
}

// ── Baselines ──────────────────────────────────────

export interface BaselineRow {
  model: string;
  metric: string;
  avg_7d: number | null;
  avg_30d: number | null;
  sample_count: number;
  updated_at: number | null;
}

export function getBaseline(model: string, metric: string): BaselineRow | null {
  const db = getDb();
  return db.prepare(`SELECT * FROM baselines WHERE model = ? AND metric = ?`).get(model, metric) as BaselineRow | null;
}

export function upsertBaseline(model: string, metric: string, value: number) {
  const db = getDb();
  const existing = getBaseline(model, metric);

  if (!existing) {
    db.prepare(
      `INSERT INTO baselines (model, metric, avg_7d, avg_30d, sample_count, updated_at) VALUES (?, ?, ?, ?, 1, ?)`
    ).run(model, metric, value, value, Date.now());
    return;
  }

  const avg7d = existing.avg_7d != null ? existing.avg_7d * 0.7 + value * 0.3 : value;
  const avg30d = existing.avg_30d != null ? existing.avg_30d * 0.9 + value * 0.1 : value;

  db.prepare(
    `UPDATE baselines SET avg_7d = ?, avg_30d = ?, sample_count = sample_count + 1, updated_at = ? WHERE model = ? AND metric = ?`
  ).run(avg7d, avg30d, Date.now(), model, metric);
}

// ── File cursors (backfill / lazy catch-up) ─────────

export interface CursorRow {
  path: string;
  offset: number;
  mtime_ms: number;
  last_model: string | null;
  last_session_id: string | null;
  updated_at: number;
}

export function getCursor(path: string): CursorRow | null {
  return getDb().prepare(`SELECT * FROM file_cursors WHERE path = ?`).get(path) as CursorRow | null;
}

export function upsertCursor(c: Omit<CursorRow, "updated_at">) {
  getDb().prepare(`
    INSERT INTO file_cursors (path, offset, mtime_ms, last_model, last_session_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      offset = excluded.offset,
      mtime_ms = excluded.mtime_ms,
      last_model = COALESCE(excluded.last_model, last_model),
      last_session_id = COALESCE(excluded.last_session_id, last_session_id),
      updated_at = excluded.updated_at
  `).run(c.path, c.offset, c.mtime_ms, c.last_model ?? null, c.last_session_id ?? null, Date.now());
}

export function countCursors(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM file_cursors`).get() as { n: number }).n;
}

// ── Prefs ───────────────────────────────────────────

export function getPref(key: string): string | null {
  const r = getDb().prepare(`SELECT value FROM prefs WHERE key = ?`).get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setPref(key: string, value: string) {
  getDb().prepare(`
    INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}
