import { appendFileSync, existsSync, mkdirSync, statSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./store/db.js";

const MAX_BYTES = 256 * 1024;
const DEBUG = process.env.NERFDETECTOR_DEBUG === "1";

function logPath(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "ingest.log");
}

function rotateIfNeeded(p: string) {
  try {
    if (statSync(p).size > MAX_BYTES) renameSync(p, p + ".1");
  } catch {}
}

function write(level: string, msg: string) {
  try {
    const p = logPath();
    const fresh = !existsSync(p);
    rotateIfNeeded(p);
    appendFileSync(p, `${new Date().toISOString()} ${level} ${msg}\n`);
    if (fresh) {
      try { chmodSync(p, 0o600); } catch {}
    }
  } catch {}
}

export function logError(where: string, err: unknown, extra?: Record<string, unknown>) {
  const m = err instanceof Error ? `${err.message}` : String(err);
  const ex = extra ? " " + JSON.stringify(extra) : "";
  write("ERROR", `${where}: ${m}${ex}`);
}

export function logDebug(where: string, msg: string, extra?: Record<string, unknown>) {
  if (!DEBUG) return;
  const ex = extra ? " " + JSON.stringify(extra) : "";
  write("DEBUG", `${where}: ${msg}${ex}`);
}

export function isDebug(): boolean {
  return DEBUG;
}

export function getLogPath(): string {
  return join(getDataDir(), "ingest.log");
}
