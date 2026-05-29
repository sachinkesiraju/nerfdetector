import chalk from "chalk";
import { createHash } from "node:crypto";
import { insertEvent, getRecentEvents } from "./store/db.js";
import { normalizeModelId, type StatusTier } from "./models.js";
import { fetchGlobalStatus } from "./vote.js";
import { readModelFromTranscript } from "./transcript.js";
import { logDebug, logError } from "./log.js";
import { sparkline, tierColor } from "./viz.js";

function hashToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  try {
    const s = JSON.stringify(input);
    if (!s || s.length < 2) return undefined;
    return createHash("sha256").update(s).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

const MAX_INPUT_SIZE = 65536;
const STDIN_TIMEOUT_MS = 5000;
const SESSION_GAP_MS = 10 * 60 * 1000;

function tierEmoji(tier: StatusTier): string {
  return tier === "fine" ? "🟢" : tier === "nerfed" ? "🔴" : "🟡";
}

export async function ingest(tool: string) {
  const input = await readStdin();
  if (!input.trim()) {
    logDebug("ingest", "empty stdin", { tool });
    return;
  }

  let data: any;
  try {
    data = JSON.parse(input);
  } catch (err) {
    logError("ingest.parse", err, { tool, len: input.length });
    return;
  }

  try {
    const hookEvent = data.hook_event_name;
    logDebug("ingest", "hook fired", { tool, hookEvent, keys: Object.keys(data) });

    let raw =
      data.model ||
      data.modelId ||
      process.env.CLAUDE_MODEL ||
      "";

    if (!raw && data.transcript_path) {
      const fromTranscript = readModelFromTranscript(data.transcript_path);
      if (fromTranscript) {
        raw = fromTranscript;
        logDebug("ingest", "model from transcript", { model: raw });
      }
    }

    if (!raw) {
      logError("ingest.no-model", "no model id available", {
        tool, hookEvent, hasTranscript: !!data.transcript_path,
      });
      return;
    }
    const model = normalizeModelId(raw);

    const sessionId: string | undefined = data.session_id;

    if (hookEvent === "UserPromptSubmit") {
      const recent = getRecentEvents(SESSION_GAP_MS);
      if (recent.length === 0) {
        showSessionStartStatus(model).catch(() => {});
      }

      insertEvent(tool, model, "prompt", { sessionId, source: "hook" });
      return;
    }

    // PostToolUse — capture tool name and response size
    const toolName: string | undefined = data.tool_name || data.toolName;
    let responseSize: number | undefined;

    // Measure tool_response size without reading content
    if (data.tool_response != null) {
      try {
        responseSize = JSON.stringify(data.tool_response).length;
      } catch {}
    }

    const status = (data.error || data.status === "error") ? "error" : "ok";
    const toolOk = toolName ? (data.success !== false && data.error == null) : undefined;
    const durationMs: number | undefined = data.duration_ms ?? data.durationMs ?? undefined;

    const toolInputHash = hashToolInput(data.tool_input ?? data.toolInput);

    insertEvent(tool, model, "tool_use", {
      durationMs, status, toolOk, toolName, responseSize, sessionId,
      toolInputHash,
      source: "hook",
    });
  } catch (err) {
    logError("ingest.handle", err, { tool });
  }
}

async function showSessionStartStatus(model: string) {
  try {
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
      const pct = m.sentimentScore !== null ? `${Math.round(m.sentimentScore * 100)}%` : "";
      const spark = sparkline(m.sparkline, 8);
      const trend = spark ? tierColor(m.tier)(spark) + " " : "";
      console.log(chalk.gray(`  nerfdetector · ${m.displayName}: ${tierEmoji(m.tier)} ${trend}${chalk.gray(pct + " · " + total + " reports")}`));
    }
  } catch {}
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
