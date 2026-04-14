import chalk from "chalk";
import { insertEvent, getRecentEvents } from "./store/db.js";
import { normalizeModelId, type StatusTier } from "./models.js";
import { fetchGlobalStatus } from "./vote.js";

const MAX_INPUT_SIZE = 65536;
const STDIN_TIMEOUT_MS = 5000;
const SESSION_GAP_MS = 10 * 60 * 1000; // 10 min gap = new session

function tierEmoji(tier: StatusTier): string {
  return tier === "fine" ? "🟢" : tier === "nerfed" ? "🔴" : "🟡";
}

export async function ingest(tool: string) {
  const input = await readStdin();
  if (!input.trim()) return;

  try {
    const data = JSON.parse(input);
    const hookEvent = data.hook_event_name;

    const raw = data.model || data.modelId || process.env.CLAUDE_MODEL || "";
    if (!raw) return; // no model identified — skip silently
    const model = normalizeModelId(raw);

    if (hookEvent === "UserPromptSubmit") {
      // Check if this is the start of a new session (gap in activity)
      const recent = getRecentEvents(SESSION_GAP_MS);
      if (recent.length === 0) {
        // New session — show model status
        showSessionStartStatus(model).catch(() => {});
      }

      insertEvent(tool, model, "prompt", undefined, "ok", undefined);
      return;
    }

    let eventType = "tool_use";
    let status = "ok";
    let toolOk: boolean | undefined;

    if (data.error || data.status === "error") status = "error";
    if (data.tool_name || data.toolName) {
      toolOk = data.success !== false && data.error == null;
    }

    const durationMs: number | undefined = data.duration_ms ?? data.durationMs ?? undefined;
    if (data.event_type || data.eventType) eventType = data.event_type || data.eventType;

    insertEvent(tool, model, eventType, durationMs, status, toolOk);
  } catch {
    // Silent — never crash on bad data from hooks
  }
}

async function showSessionStartStatus(model: string) {
  try {
    // 2s timeout — fetchGlobalStatus catches its own errors
    const data = await Promise.race([
      fetchGlobalStatus(),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);
    if (!data?.models) return;

    const m = data.models.find((x) => x.modelId === model);
    if (!m) return;

    const total = m.voteCount + m.sessionCount;
    if (total === 0) {
      console.log(chalk.gray(`  nerfdetector · ${m.displayName}: ⚪ no data yet`));
    } else {
      const pct = m.sentimentScore !== null ? `${Math.round(m.sentimentScore * 100)}% sentiment` : "";
      console.log(chalk.gray(`  nerfdetector · ${m.displayName}: ${tierEmoji(m.tier)} ${pct} · ${total} reports`));
    }
  } catch {
    // Silent — never block the user
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let input = "";
    const timeout = setTimeout(() => { cleanup(); resolve(input); }, STDIN_TIMEOUT_MS);

    function onData(chunk: Buffer) {
      input += chunk;
      if (input.length > MAX_INPUT_SIZE) { cleanup(); resolve(input); }
    }

    function onEnd() { cleanup(); resolve(input); }

    function cleanup() {
      clearTimeout(timeout);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
    }

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });
}
