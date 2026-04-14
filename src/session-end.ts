import chalk from "chalk";
import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { ReadStream } from "node:tty";
import { join } from "node:path";
import { getRecentEvents, getDataDir, getBaseline, upsertBaseline, insertEvent } from "./store/db.js";
import { computeAttribution, submitVote, getApiBase } from "./vote.js";
import { getDeviceId } from "./device.js";

const MIN_ACTIONS = 5;
const COOLDOWN_MS = 15 * 60 * 1000;
const PROMPT_FILE = "last_prompted";

function getLastPromptedAt(): number {
  try {
    return parseInt(readFileSync(join(getDataDir(), PROMPT_FILE), "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function setLastPromptedAt(): boolean {
  try {
    writeFileSync(join(getDataDir(), PROMPT_FILE), String(Date.now()), "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function handleSessionEnd() {
  if (!process.stdin.isTTY) {
    process.stdin.resume();
    await new Promise((r) => setTimeout(r, 50));
    process.stdin.pause();
  }

  const events = getRecentEvents();
  const context = computeAttribution(events);
  if (!context.hasEvents) return;

  const lastPrompted = getLastPromptedAt();
  const recentToolEvents = events.filter(
    (e) => e.event_type === "tool_use" && e.ts > lastPrompted
  );

  if (recentToolEvents.length < MIN_ACTIONS) return;
  if (Date.now() - lastPrompted < COOLDOWN_MS) return;

  const totalActions = recentToolEvents.length;
  const failed = recentToolEvents.filter((e) => e.tool_ok !== 1).length;

  const entries = Object.entries(context.attribution)
    .sort((a, b) => b[1] - a[1])
    .map(([m, w]) => `${m} (${Math.round(w * 100)}%)`)
    .join(" + ");

  let statsStr = failed === 0
    ? `${totalActions} actions · all succeeded`
    : `${totalActions} actions · ${failed} failed`;

  // Add retry info if significant
  const meta = context.sessionMeta;
  if (meta.retriesTotal && meta.retriesTotal >= 3) {
    statsStr += ` · ${meta.retriesTotal} retries`;
  }

  console.log("");
  console.log(chalk.gray(`  nerfdetector · ${entries} · ${statsStr}`));

  // Personal baseline comparison
  const baselineAlert = checkBaselines(context);
  if (baselineAlert) {
    console.log(chalk.yellow(`  ${baselineAlert}`));
  }

  process.stdout.write(chalk.gray("  how was your session? ") + chalk.green("[f]") + " fine  " + chalk.yellow("[m]") + " mid  " + chalk.red("[n]") + " nerfed  " + chalk.gray("[s]") + " skip  ");

  const key = await readKeyFromTty(5000);

  if (key === "f" || key === "m" || key === "n") {
    const direction = key === "f" ? 1 : key === "m" ? 0 : -1;
    const label = key === "f" ? chalk.green("✓ fine") : key === "m" ? chalk.yellow("✓ mid") : chalk.red("✓ nerfed");
    setLastPromptedAt();

    // Store vote locally for history
    const primaryModel = Object.entries(context.attribution).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (primaryModel) {
      insertEvent("local", primaryModel, "vote", { status: String(direction) });
    }

    try {
      const result = await submitVote(direction as 1 | 0 | -1, context);
      console.log(result.ok ? label : chalk.red(`✗ ${result.error}`));
    } catch { console.log(chalk.red("✗ network error")); }
  } else {
    setLastPromptedAt();
    console.log(chalk.gray("skipped"));
    const errorRate = totalActions > 0 ? meta.errorCount / totalActions : 0;
    const toolFailRate = totalActions > 0 ? failed / totalActions : 0;
    const healthy = errorRate < 0.05 && toolFailRate < 0.1;
    const oldestTs = events.length > 0 ? events[events.length - 1].ts : Date.now();
    const durationS = Math.max(1, Math.round((Date.now() - oldestTs) / 1000));
    try {
      await fetch(`${getApiBase()}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attribution: context.attribution, healthy, callCount: meta.callCount,
          errorRate, toolFailRate, durationS, deviceId: getDeviceId(),
        }),
      });
    } catch {}
  }

  // Update personal baselines (always, regardless of vote/skip)
  updateBaselines(context);

  console.log("");
}

// ── Baselines ──────────────────────────────────────

function checkBaselines(context: import("./vote.js").VoteContext): string | null {
  const meta = context.sessionMeta;
  const primaryModel = Object.entries(context.attribution)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!primaryModel) return null;

  const alerts: string[] = [];

  // Use tool_use events only (not prompts/votes) for rate calculations
  const toolUseEvents = getRecentEvents().filter((e) => e.event_type === "tool_use");
  const toolUseCount = toolUseEvents.length;
  if (toolUseCount >= 5) {
    const failRate = (meta.toolFailCount ?? 0) / toolUseCount;
    const successRate = 1 - failRate;
    const bl = getBaseline(primaryModel, "success_rate");
    if (bl && bl.sample_count >= 3 && bl.avg_7d != null) {
      const deviation = (bl.avg_7d - successRate) / bl.avg_7d;
      if (deviation > 0.2) { // 20%+ worse than your norm
        alerts.push(`${Math.round(deviation * 100)}% more failures than your norm`);
      }
    }
  }

  // Check response size against baseline
  if (meta.medianResponseSize) {
    const bl = getBaseline(primaryModel, "response_size");
    if (bl && bl.sample_count >= 3 && bl.avg_7d != null && bl.avg_7d > 0) {
      const deviation = (bl.avg_7d - meta.medianResponseSize) / bl.avg_7d;
      if (deviation > 0.3) { // 30%+ shorter responses
        alerts.push(`responses ${Math.round(deviation * 100)}% shorter than usual`);
      }
    }
  }

  // Check retry rate
  if (meta.retriesTotal && meta.retriesTotal > 0) {
    const retryRate = meta.retriesTotal / toolUseCount;
    const bl = getBaseline(primaryModel, "retry_rate");
    if (bl && bl.sample_count >= 3 && bl.avg_7d != null) {
      const deviation = retryRate - bl.avg_7d;
      if (deviation > 0.1) { // 10%+ more retries than norm
        alerts.push(`${Math.round(deviation * 100)}% more retries than usual`);
      }
    }
  }

  if (alerts.length === 0) return null;
  return `⚠ this session: ${alerts.join(", ")}`;
}

function updateBaselines(context: import("./vote.js").VoteContext) {
  const meta = context.sessionMeta;
  const primaryModel = Object.entries(context.attribution)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!primaryModel) return;

  const tuCount = getRecentEvents().filter((e) => e.event_type === "tool_use").length;
  if (tuCount >= 3) {
    const failRate = (meta.toolFailCount ?? 0) / tuCount;
    upsertBaseline(primaryModel, "success_rate", 1 - failRate);
  }

  if (meta.medianResponseSize) {
    upsertBaseline(primaryModel, "response_size", meta.medianResponseSize);
  }

  if (meta.retriesTotal != null) {
    const retryRate = tuCount > 0 ? meta.retriesTotal / tuCount : 0;
    upsertBaseline(primaryModel, "retry_rate", retryRate);
  }
}

// ── TTY keypress ──────────────────────────────────

function readKeyFromTty(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let fd: number;
    try {
      fd = openSync("/dev/tty", "r");
    } catch {
      resolve(null);
      return;
    }

    let stream: ReadStream;
    try {
      stream = new ReadStream(fd, { autoClose: false } as any);
      stream.setRawMode(true);
    } catch {
      try { closeSync(fd); } catch {}
      resolve(null);
      return;
    }

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      try { stream.setRawMode(false); } catch {}
      stream.destroy();
      try { closeSync(fd); } catch {}
    }

    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);

    stream.once("data", (data: Buffer) => {
      cleanup();
      const ch = data.toString().toLowerCase();
      resolve(ch === "\u0003" ? null : ch[0] ?? null);
    });

    stream.once("error", () => {
      cleanup();
      resolve(null);
    });
  });
}
