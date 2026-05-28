import { createHash } from "node:crypto";
import type { EventRow } from "../store/db.js";

export const FINGERPRINT_SCHEMA_VERSION = 1;

// Built-in tool name allowlist. Anything outside this set is treated as
// custom/MCP and hashed to prevent deanonymization via unique tool names.
const ALLOWED_TOOLS = new Set([
  // Claude Code
  "Bash", "Edit", "Read", "Write", "Grep", "Glob", "Task", "WebFetch",
  "WebSearch", "NotebookEdit", "TodoWrite", "ExitPlanMode", "Skill",
  "MultiEdit",
  // Codex CLI
  "shell", "apply_patch", "update_plan", "view_image", "multi_tool_use.parallel",
  "exec_command", "write_stdin",
  // Gemini CLI
  "run_shell_command", "list_directory", "search_file_content", "read_file",
  "write_file", "edit", "glob", "save_memory", "web_fetch", "web_search",
]);

export interface DeviationFromBaseline {
  /** current - baseline_7d. Positive = you scored higher (better). */
  successRate: number | null;
  /** current - baseline_7d. Positive = you retried more (worse). */
  retryRate: number | null;
  /** current p50 in seconds - baseline_7d in seconds. Positive = slower (worse). */
  latency: number | null;
}

export interface Fingerprint {
  schemaVersion: typeof FINGERPRINT_SCHEMA_VERSION;
  sessionDurationS: number;
  toolCallCount: number;
  loops: number;
  resteers: number;
  toolFailRate: number;
  retryRate: number;
  topFailingTool: string | null;
  deviationFromBaseline: DeviationFromBaseline;
  clientVersion: string;
}

export interface ScoreInput {
  events: EventRow[];
  baselines?: {
    successRate?: number | null;
    retryRate?: number | null;
    /** baseline median tool latency in seconds */
    latencyS?: number | null;
  };
  clientVersion: string;
}

/**
 * Normalize a tool name into either an allowlisted built-in name or a stable
 * salted hash. Custom names are bucketed as `custom_<8 hex chars>`.
 */
export function safeToolName(name: string | null | undefined): string | null {
  if (!name) return null;
  if (ALLOWED_TOOLS.has(name)) return name;
  // Hash without a salt — purpose is bucketing, not secrecy. Same custom tool
  // across users maps to the same bucket so the server can rank.
  const h = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `custom_${h}`;
}

/**
 * Score a set of events into a fingerprint. Pure function — no I/O.
 *
 * Loops: each maximal run of ≥3 consecutive same tool_name calls counts once.
 * Resteers: UserPromptSubmit prompts that arrive within 60s after a cluster
 * of ≥2 tool failures within 60s of each other.
 */
export function scoreSession(input: ScoreInput): Fingerprint {
  const sorted = [...input.events].sort((a, b) => a.ts - b.ts);
  const toolEvents = sorted.filter((e) => e.event_type === "tool_use");
  const promptEvents = sorted.filter((e) => e.event_type === "prompt");
  const toolCallCount = toolEvents.length;

  // Duration: first event → last event, clamp to ≥0
  const sessionDurationS = sorted.length > 0
    ? Math.max(0, Math.round((sorted[sorted.length - 1].ts - sorted[0].ts) / 1000))
    : 0;

  // Failure rate
  const failures = toolEvents.filter((e) => e.tool_ok === 0);
  const toolFailRate = toolCallCount > 0
    ? round3(failures.length / toolCallCount)
    : 0;

  // Loops + retries: scan consecutive same tool_name runs.
  // A "retry" event is the 3rd, 4th, ... consecutive call to the same tool.
  // A "loop" is a maximal run of length ≥3 (counted once).
  let loops = 0;
  let retries = 0;
  let lastName: string | null = null;
  let streak = 0;
  let inLoopAlready = false;
  for (const ev of toolEvents) {
    if (ev.tool_name === lastName && ev.tool_name != null) {
      streak++;
      if (streak >= 3) retries++;
      if (streak === 3 && !inLoopAlready) {
        loops++;
        inLoopAlready = true;
      }
    } else {
      streak = 1;
      inLoopAlready = false;
    }
    lastName = ev.tool_name;
  }
  const retryRate = toolCallCount > 0 ? round3(retries / toolCallCount) : 0;

  // Resteers: prompts that follow a failure cluster.
  // A "failure cluster" = ≥2 failures within a 60s sliding window before the prompt.
  const RESTEER_WINDOW = 60_000;
  let resteers = 0;
  for (const p of promptEvents) {
    const recentFailures = failures.filter(
      (f) => f.ts < p.ts && f.ts >= p.ts - RESTEER_WINDOW
    );
    if (recentFailures.length >= 2) resteers++;
  }

  // Top failing tool — name with the most failures
  let topFailingTool: string | null = null;
  if (failures.length > 0) {
    const counts = new Map<string, number>();
    for (const f of failures) {
      if (!f.tool_name) continue;
      counts.set(f.tool_name, (counts.get(f.tool_name) ?? 0) + 1);
    }
    let bestName: string | null = null;
    let bestCount = 0;
    for (const [name, c] of counts) {
      if (c > bestCount) {
        bestCount = c;
        bestName = name;
      }
    }
    topFailingTool = safeToolName(bestName);
  }

  // Deviation vs baselines
  const bl = input.baselines ?? {};
  const successRate = 1 - toolFailRate;
  const medianLatencyS = medianLatencySeconds(toolEvents);

  const deviationFromBaseline: DeviationFromBaseline = {
    successRate: bl.successRate != null ? round3(successRate - bl.successRate) : null,
    retryRate: bl.retryRate != null ? round3(retryRate - bl.retryRate) : null,
    latency: bl.latencyS != null && medianLatencyS != null
      ? round3(medianLatencyS - bl.latencyS)
      : null,
  };

  return {
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    sessionDurationS,
    toolCallCount,
    loops,
    resteers,
    toolFailRate,
    retryRate,
    topFailingTool,
    deviationFromBaseline,
    clientVersion: input.clientVersion,
  };
}

function medianLatencySeconds(toolEvents: EventRow[]): number | null {
  const durations = toolEvents
    .map((e) => e.duration_ms)
    .filter((d): d is number => d != null && d > 0);
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const ms = durations.length % 2 === 0
    ? (durations[mid - 1] + durations[mid]) / 2
    : durations[mid];
  return round3(ms / 1000);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
