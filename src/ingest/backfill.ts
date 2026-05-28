import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { insertEvent, getCursor, upsertCursor } from "../store/db.js";
import { normalizeModelId } from "../models.js";
import { logDebug, logError } from "../log.js";
import { parseClaudeCodeChunk } from "./parser.js";

const HOME = homedir();
const MAX_CHUNK_BYTES = 16 * 1024 * 1024; // 16MB per file per run

interface Source {
  tool: "claude-code" | "codex" | "gemini";
  dir: string;
  parse: typeof parseClaudeCodeChunk;
}

const SOURCES: Source[] = [
  { tool: "claude-code", dir: join(HOME, ".claude", "projects"), parse: parseClaudeCodeChunk },
  // Codex JSONLs have a heterogeneous schema; live hooks already cover them.
  // Gemini JSONL backfill: deferred until we have a real test corpus.
];

export interface BackfillStats {
  filesScanned: number;
  newEvents: number;
  errors: number;
  bytesRead: number;
}

/**
 * Find all .jsonl files under a directory, optionally newer than `sinceMs`.
 * Recursive but capped at 3 levels deep.
 */
function findJsonl(root: string, sinceMs: number | null, maxDepth = 3): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const st = statSync(p);
          if (sinceMs == null || st.mtimeMs >= sinceMs) out.push(p);
        } catch {}
      }
    }
  }
  walk(root, 0);
  return out;
}

/**
 * Catch up all known cursors AND newly-discovered transcripts. Idempotent.
 * Returns stats; safe to call from any non-hook command path.
 */
export function catchUpCursors(opts: { sinceDays?: number; quiet?: boolean } = {}): BackfillStats {
  const sinceMs = opts.sinceDays != null ? Date.now() - opts.sinceDays * 24 * 3600 * 1000 : null;
  const stats: BackfillStats = { filesScanned: 0, newEvents: 0, errors: 0, bytesRead: 0 };

  for (const src of SOURCES) {
    const files = findJsonl(src.dir, sinceMs);
    for (const path of files) {
      try {
        stats.filesScanned++;
        const events = scanFile(src, path);
        stats.newEvents += events;
      } catch (err) {
        stats.errors++;
        logError("backfill.file", err, { path });
      }
    }
  }

  if (!opts.quiet) {
    logDebug("backfill", "catch-up complete", stats as any);
  }
  return stats;
}

function scanFile(src: Source, path: string): number {
  let st;
  try { st = statSync(path); } catch { return 0; }

  const cur = getCursor(path);
  // Skip if file unchanged since last scan
  if (cur && cur.mtime_ms === st.mtimeMs && cur.offset >= st.size) return 0;

  const startOffset = cur?.offset ?? 0;
  if (startOffset >= st.size) {
    // mtime changed but no new bytes (truncation, edit) — reset cursor to head
    upsertCursor({ path, offset: st.size, mtime_ms: st.mtimeMs, last_model: cur?.last_model ?? null, last_session_id: cur?.last_session_id ?? null });
    return 0;
  }

  const toRead = Math.min(st.size - startOffset, MAX_CHUNK_BYTES);
  const buf = Buffer.alloc(toRead);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, toRead, startOffset);
  } finally {
    closeSync(fd);
  }

  const result = src.parse(buf, startOffset);
  let inserted = 0;
  for (const e of result.events) {
    const id = insertEvent(src.tool, normalizeModelId(e.model), e.eventType, {
      ts: e.ts,
      toolName: e.toolName,
      toolOk: e.toolOk,
      durationMs: e.durationMs,
      responseSize: e.responseSize,
      sessionId: e.sessionId,
      source: "backfill",
      sourceOffset: e.sourceOffset,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      toolInputHash: e.toolInputHash,
    });
    if (id != null) inserted++;
  }

  upsertCursor({
    path,
    offset: result.newOffset,
    mtime_ms: st.mtimeMs,
    last_model: result.lastModel ?? cur?.last_model ?? null,
    last_session_id: result.lastSessionId ?? cur?.last_session_id ?? null,
  });

  return inserted;
}

/**
 * Spawn a detached background catch-up. Used by `init` so install returns fast.
 */
export function spawnBackfill(sinceDays: number) {
  const child = spawn(process.execPath, [
    process.argv[1] ?? "",
    "_backfill",
    "--days", String(sinceDays),
  ], { detached: true, stdio: "ignore" });
  child.unref();
}
