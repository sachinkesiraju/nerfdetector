import { insertEvent } from "./store/db.js";
import { normalizeModelId } from "./models.js";

const MAX_INPUT_SIZE = 65536; // 64KB
const STDIN_TIMEOUT_MS = 5000;

export async function ingest(tool: string) {
  // Read stdin with a timeout — hooks should send finite data then close
  const input = await readStdin();
  if (!input.trim()) return;

  try {
    const data = JSON.parse(input);
    const hookEvent = data.hook_event_name;

    const raw = data.model || data.modelId || process.env.CLAUDE_MODEL || "unknown";
    const model = normalizeModelId(raw);

    if (hookEvent === "UserPromptSubmit") {
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
