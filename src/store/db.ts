import Database from "better-sqlite3";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NERFDETECTOR_DIR = join(homedir(), ".nerfdetector");
const DB_PATH = join(NERFDETECTOR_DIR, "events.db");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    tool TEXT NOT NULL,
    model TEXT NOT NULL,
    event_type TEXT NOT NULL,
    duration_ms INTEGER,
    status TEXT,
    tool_ok INTEGER,
    tool_name TEXT,
    response_size INTEGER,
    session_id TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ts ON events (ts DESC);
  CREATE INDEX IF NOT EXISTS events_session ON events (session_id);

  CREATE TABLE IF NOT EXISTS baselines (
    model TEXT NOT NULL,
    metric TEXT NOT NULL,
    avg_7d REAL,
    avg_30d REAL,
    sample_count INTEGER DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (model, metric)
  );
`;

// Migrate existing DBs that lack new columns
const MIGRATIONS = [
  "ALTER TABLE events ADD COLUMN tool_name TEXT",
  "ALTER TABLE events ADD COLUMN response_size INTEGER",
  "ALTER TABLE events ADD COLUMN session_id TEXT",
];

let _db: Database.Database | null = null;

export function getDataDir(): string {
  return NERFDETECTOR_DIR;
}

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(NERFDETECTOR_DIR)) {
    mkdirSync(NERFDETECTOR_DIR, { recursive: true });
  }

  try {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.exec(SCHEMA);
    // Run migrations for existing DBs
    for (const sql of MIGRATIONS) {
      try { _db.exec(sql); } catch {} // ignore "duplicate column" errors
    }
  } catch {
    try { _db?.close(); } catch {}
    _db = null;
    try { unlinkSync(DB_PATH); } catch {}
    try { unlinkSync(DB_PATH + "-wal"); } catch {}
    try { unlinkSync(DB_PATH + "-shm"); } catch {}

    try {
      _db = new Database(DB_PATH);
      _db.pragma("journal_mode = WAL");
      _db.exec(SCHEMA);
    } catch {
      _db = null;
      throw new Error("nerfdetector: could not create database");
    }
  }

  return _db;
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
}

const VALID_TOOLS = new Set(["claude-code", "codex", "gemini", "local"]);

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
  }
) {
  if (!VALID_TOOLS.has(tool)) return;
  if (model.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(model)) return;

  const o = opts ?? {};
  const db = getDb();
  db.prepare(
    `INSERT INTO events (ts, tool, model, event_type, duration_ms, status, tool_ok, tool_name, response_size, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(), tool, model, eventType,
    o.durationMs ?? null,
    o.status ?? null,
    o.toolOk != null ? (o.toolOk ? 1 : 0) : null,
    o.toolName ?? null,
    o.responseSize ?? null,
    o.sessionId ?? null
  );
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

  // Exponential moving average: 7d uses alpha=0.3, 30d uses alpha=0.1
  const avg7d = existing.avg_7d != null ? existing.avg_7d * 0.7 + value * 0.3 : value;
  const avg30d = existing.avg_30d != null ? existing.avg_30d * 0.9 + value * 0.1 : value;

  db.prepare(
    `UPDATE baselines SET avg_7d = ?, avg_30d = ?, sample_count = sample_count + 1, updated_at = ? WHERE model = ? AND metric = ?`
  ).run(avg7d, avg30d, Date.now(), model, metric);
}
