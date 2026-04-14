import chalk from "chalk";
import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { ReadStream } from "node:tty";
import { join } from "node:path";
import { getRecentEvents, getDataDir } from "./store/db.js";
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
  // Drain stdin (hook payload) — skip if stdin is a TTY (not piped)
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

  const statsStr = failed === 0
    ? `${totalActions} actions · all succeeded`
    : `${totalActions} actions · ${failed} failed`;

  console.log("");
  console.log(chalk.gray(`  nerfdetector · ${entries} · ${statsStr}`));
  process.stdout.write(chalk.gray("  how was your session? ") + chalk.green("[f]") + " fine  " + chalk.yellow("[m]") + " mid  " + chalk.red("[n]") + " nerfed  " + chalk.gray("[s]") + " skip  ");

  const key = await readKeyFromTty(5000);

  if (key === "f" || key === "m" || key === "n") {
    const direction = key === "f" ? 1 : key === "m" ? 0 : -1;
    const label = key === "f" ? chalk.green("✓ fine") : key === "m" ? chalk.yellow("✓ mid") : chalk.red("✓ nerfed");
    setLastPromptedAt();
    try {
      const result = await submitVote(direction as 1 | 0 | -1, context);
      console.log(result.ok ? label : chalk.red(`✗ ${result.error}`));
    } catch { console.log(chalk.red("✗ network error")); }
  } else {
    // Skip or timeout — consume cooldown so we don't re-prompt immediately
    setLastPromptedAt();
    console.log(chalk.gray("skipped"));
    const meta = context.sessionMeta;
    const errorRate = meta.callCount > 0 ? meta.errorCount / meta.callCount : 0;
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

  console.log("");
}

/**
 * Read a single keypress from /dev/tty in raw mode.
 * No enter needed. Falls back to null if no terminal available.
 */
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
