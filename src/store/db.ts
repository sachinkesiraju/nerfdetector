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
    tool_ok INTEGER
  );
  CREATE INDEX IF NOT EXISTS events_ts ON events (ts DESC);
`;

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
  } catch {
    // Close the failed handle if it exists
    try { _db?.close(); } catch {}
    _db = null;

    // Delete corrupted DB files and recreate
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

// Close DB on process exit
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
}

const VALID_TOOLS = new Set(["claude-code", "codex", "gemini"]);

export function insertEvent(
  tool: string,
  model: string,
  eventType: string,
  durationMs?: number,
  status?: string,
  toolOk?: boolean
) {
  if (!VALID_TOOLS.has(tool)) return;
  if (model.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(model)) return;

  const db = getDb();
  db.prepare(
    `INSERT INTO events (ts, tool, model, event_type, duration_ms, status, tool_ok) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(Date.now(), tool, model, eventType, durationMs ?? null, status ?? null, toolOk != null ? (toolOk ? 1 : 0) : null);
}

export function getRecentEvents(windowMs: number = 15 * 60 * 1000): EventRow[] {
  const db = getDb();
  const cutoff = Date.now() - windowMs;
  return db.prepare(`SELECT * FROM events WHERE ts > ? ORDER BY ts DESC`).all(cutoff) as EventRow[];
}
