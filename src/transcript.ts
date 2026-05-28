import { openSync, readSync, closeSync, statSync } from "node:fs";
import { logDebug, logError } from "./log.js";

interface CacheEntry {
  model: string | null;
  mtimeMs: number;
  size: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_TAIL_BYTES = 64 * 1024;

/**
 * Read the latest assistant model from a Claude Code JSONL transcript.
 * Tails up to 64KB and scans backwards for the last assistant record.
 * Caches by (path, mtime, size) so successive PostToolUse calls are O(1).
 */
export function readModelFromTranscript(path: string): string | null {
  if (!path) return null;

  let st;
  try {
    st = statSync(path);
  } catch {
    logDebug("transcript", "stat failed", { path });
    return null;
  }

  const cached = cache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.model;
  }

  let model: string | null = null;
  try {
    const tailLen = Math.min(MAX_TAIL_BYTES, st.size);
    const buf = Buffer.alloc(tailLen);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, tailLen, st.size - tailLen);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.length < 10) continue;
      // Cheap pre-filter: must contain a "model" field
      if (!line.includes('"model"')) continue;
      try {
        const rec = JSON.parse(line);
        // Claude Code shape: { type:"assistant", message:{ model } }
        // Gemini shape:      { type:"gemini",    model }
        // Codex shape:       { type:"turn_context", payload:{ model } } or session_meta
        const m =
          rec?.message?.model ??
          (rec?.type === "gemini" ? rec?.model : null) ??
          rec?.payload?.model ??
          rec?.model;
        if (typeof m === "string" && m.length > 0 && m.length < 128) {
          model = m;
          break;
        }
      } catch {
        // Partial line at start of tail — expected, keep scanning
      }
    }
  } catch (err) {
    logError("transcript.read", err, { path });
  }

  cache.set(path, { model, mtimeMs: st.mtimeMs, size: st.size });
  return model;
}
