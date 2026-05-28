/**
 * JSONL transcript parsers. Pure functions — no I/O.
 *
 * For each supported tool we provide a function that takes a chunk of new
 * bytes (since the last cursor) and emits {events, newOffset, lastModel, lastSessionId}.
 *
 * Important invariant: `newOffset` is the byte offset of the start of the
 * first incomplete line at the end of the chunk (or the end of the chunk if
 * it terminates with a newline). Callers persist this so the next run
 * resumes exactly there.
 */

export interface ParsedEvent {
  ts: number;
  eventType: "tool_use" | "prompt";
  toolName?: string;
  toolOk?: boolean;
  durationMs?: number;
  responseSize?: number;
  sessionId: string;
  model: string;
  sourceOffset: number;
}

export interface ParseResult {
  events: ParsedEvent[];
  newOffset: number;
  lastModel: string | null;
  lastSessionId: string | null;
}

/**
 * Claude Code JSONL parser.
 *
 * Records of interest:
 *  - { type: "user", message: { content: <string> } }     → prompt
 *  - { type: "assistant", message: { model, content: [...] } } with
 *      blocks of { type: "tool_use", id, name }           → start of a tool call
 *  - { type: "user", message: { content: [{ type: "tool_result", tool_use_id, is_error, content }] } }
 *                                                          → end of a tool call
 *
 * `startOffset` is the absolute byte offset within the file at which `chunk`
 * begins. We track per-line offsets so each emitted event carries the byte
 * offset of its originating line — that's our de-dup key.
 */
export function parseClaudeCodeChunk(chunk: Buffer, startOffset: number): ParseResult {
  const events: ParsedEvent[] = [];
  const pending = new Map<string, { ts: number; name: string; sessionId: string; model: string; offset: number }>();
  let lastModel: string | null = null;
  let lastSessionId: string | null = null;

  let lineStart = 0;
  let newOffset = startOffset;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] !== 0x0a) continue; // '\n'
    const lineBuf = chunk.subarray(lineStart, i);
    const absoluteOffset = startOffset + lineStart;
    newOffset = startOffset + i + 1;
    lineStart = i + 1;

    if (lineBuf.length < 10) continue;

    let rec: any;
    try {
      rec = JSON.parse(lineBuf.toString("utf-8"));
    } catch {
      continue;
    }

    const sessionId: string | null = typeof rec?.sessionId === "string" ? rec.sessionId : null;
    if (sessionId) lastSessionId = sessionId;
    const ts: number | null = rec?.timestamp ? Date.parse(rec.timestamp) : null;
    if (!sessionId || ts == null || Number.isNaN(ts)) continue;

    if (rec.type === "assistant" && rec.message) {
      const model: string | null = typeof rec.message.model === "string" ? rec.message.model : null;
      if (model) lastModel = model;
      const content = rec.message.content;
      if (Array.isArray(content) && model) {
        for (const block of content) {
          if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            pending.set(block.id, {
              ts, name: block.name, sessionId, model, offset: absoluteOffset,
            });
          }
        }
      }
    } else if (rec.type === "user" && rec.message) {
      const content = rec.message.content;
      if (typeof content === "string" && content.length > 0) {
        events.push({
          ts, eventType: "prompt",
          sessionId, model: lastModel ?? "unknown",
          sourceOffset: absoluteOffset,
        });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
            const start = pending.get(block.tool_use_id);
            if (!start) continue;
            const durationMs = Math.max(0, ts - start.ts);
            let responseSize: number | undefined;
            try {
              const raw = block.content;
              responseSize = typeof raw === "string" ? raw.length : JSON.stringify(raw ?? "").length;
            } catch {}
            events.push({
              ts, eventType: "tool_use",
              toolName: start.name,
              toolOk: block.is_error !== true,
              durationMs,
              responseSize,
              sessionId: start.sessionId,
              model: start.model,
              sourceOffset: start.offset,
            });
            pending.delete(block.tool_use_id);
          }
        }
      }
    }
  }

  // Any unmatched tool_use blocks at the end — emit as "in flight" with toolOk null.
  // We give them the start offset so re-running picks them up if a later result lands.
  // Important: we do NOT advance newOffset past their start, because the matching
  // tool_result might be in a later chunk. We rewind to the earliest unmatched start.
  let earliestUnmatched = Infinity;
  for (const p of pending.values()) {
    if (p.offset < earliestUnmatched) earliestUnmatched = p.offset;
  }
  if (earliestUnmatched < Infinity) {
    newOffset = Math.min(newOffset, earliestUnmatched);
  }

  return { events, newOffset, lastModel, lastSessionId };
}
