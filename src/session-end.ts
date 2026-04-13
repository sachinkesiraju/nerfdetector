import chalk from "chalk";
import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { ReadStream } from "node:tty";
import { join } from "node:path";
import { getRecentEvents, getDataDir } from "./store/db.js";
import { computeAttribution, submitVote } from "./vote.js";

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
  process.stdout.write(chalk.gray("  how was your session? ") + chalk.green("[f]") + " fine  " + chalk.red("[n]") + " nerfed  " + chalk.gray("[s]") + " skip  ");

  const key = await readKeyFromTty(10000);

  if (key === "n") {
    setLastPromptedAt();
    try {
      const result = await submitVote(-1, context);
      console.log(result.ok ? chalk.red("✓ nerfed") : chalk.red(`✗ ${result.error}`));
    } catch { console.log(chalk.red("✗ network error")); }
  } else if (key === "f") {
    setLastPromptedAt();
    try {
      const result = await submitVote(1, context);
      console.log(result.ok ? chalk.green("✓ fine") : chalk.red(`✗ ${result.error}`));
    } catch { console.log(chalk.red("✗ network error")); }
  } else {
    // Skip or timeout — don't consume cooldown, don't send anything
    console.log(chalk.gray("skipped"));
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
