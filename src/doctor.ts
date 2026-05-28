import chalk from "chalk";
import { existsSync, readFileSync, statSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getDataDir, getDb, getSchemaVersion, countCursors } from "./store/db.js";
import { getLogPath } from "./log.js";

const HOME = homedir();

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

function row(c: Check) {
  const mark = c.ok ? chalk.green("✓") : chalk.red("✗");
  const line = `  ${mark} ${c.label}` + (c.detail ? chalk.gray(` — ${c.detail}`) : "");
  console.log(line);
}

function fmtAgo(ts: number): string {
  const ms = Date.now() - ts;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function checkHooksFor(name: string, configPath: string, expectedCommand: string): Check {
  if (!existsSync(configPath)) {
    return { label: `${name} hooks`, ok: false, detail: "config not found" };
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const has = raw.includes(expectedCommand);
    return {
      label: `${name} hooks`,
      ok: has,
      detail: has ? configPath : `not wired in ${configPath}`,
    };
  } catch (err: any) {
    return { label: `${name} hooks`, ok: false, detail: `read failed: ${err.message}` };
  }
}

export function runDoctor() {
  console.log("");
  console.log(chalk.bold("  nerfdetector doctor"));
  console.log(chalk.gray("  ──────────────────────────"));
  console.log("");

  const dataDir = getDataDir();

  // Data dir
  let dataDirOk = false;
  let dataDirDetail = dataDir;
  try {
    accessSync(dataDir, constants.W_OK);
    dataDirOk = true;
  } catch {
    dataDirDetail = `${dataDir} (not writable)`;
  }
  row({ label: "data dir", ok: dataDirOk, detail: dataDirDetail });

  // DB
  let total = 0;
  let last24 = 0;
  let latestTs = 0;
  let dbOk = false;
  try {
    const db = getDb();
    total = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    last24 = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE ts > ?")
      .get(Date.now() - 24 * 3600 * 1000) as { n: number }).n;
    const latestRow = db.prepare("SELECT MAX(ts) AS ts FROM events").get() as { ts: number | null };
    latestTs = latestRow.ts ?? 0;
    dbOk = true;
  } catch (err: any) {
    row({ label: "events.db", ok: false, detail: `query failed: ${err.message}` });
  }

  if (dbOk) {
    row({
      label: "events.db",
      ok: true,
      detail: `${total} total · ${last24} in last 24h` + (latestTs ? ` · latest ${fmtAgo(latestTs)}` : " · no events"),
    });
  }

  // Hooks
  row(checkHooksFor("Claude Code", join(HOME, ".claude", "settings.json"), "nerfdetector _ingest claude-code"));
  row(checkHooksFor("Codex CLI",   join(HOME, ".codex", "hooks.json"),     "nerfdetector _ingest codex"));
  row(checkHooksFor("Gemini CLI",  join(HOME, ".gemini", "settings.json"), "nerfdetector _ingest gemini"));

  // Binary path
  const binary = process.execPath;
  row({ label: "node runtime", ok: true, detail: binary });

  // Schema + cursors
  try {
    const v = getSchemaVersion();
    row({ label: "schema version", ok: v >= 4, detail: `v${v}` + (v < 4 ? " (out of date)" : " (current)") });
  } catch (err: any) {
    row({ label: "schema version", ok: false, detail: err.message });
  }
  try {
    const n = countCursors();
    row({ label: "backfill cursors", ok: true, detail: `${n} transcript${n === 1 ? "" : "s"} tracked` });
  } catch {}

  // Log file
  const logFile = getLogPath();
  if (existsSync(logFile)) {
    try {
      const st = statSync(logFile);
      const mode = (st.mode & 0o777).toString(8);
      const tooOpen = mode !== "600";
      row({
        label: "ingest.log",
        ok: !tooOpen,
        detail: `${Math.round(st.size / 1024)}KB · mode ${mode}` + (tooOpen ? " (should be 600)" : ""),
      });
    } catch {
      row({ label: "ingest.log", ok: false, detail: "stat failed" });
    }
  } else {
    row({ label: "ingest.log", ok: true, detail: "no entries yet" });
  }

  // Verdict
  console.log("");
  if (dbOk && total > 0 && latestTs > Date.now() - 24 * 3600 * 1000) {
    console.log(chalk.green("  ✓ hooks are firing"));
  } else if (dbOk && latestTs > 0) {
    console.log(chalk.yellow(`  ⚠ no events in last 24h (latest: ${fmtAgo(latestTs)})`));
    console.log(chalk.gray("    run any AI tool, then re-run doctor"));
    console.log(chalk.gray("    set NERFDETECTOR_DEBUG=1 in your shell for verbose hook logs"));
  } else {
    console.log(chalk.red("  ✗ no events ever recorded"));
    console.log(chalk.gray("    if any tool above shows ✗ for hooks, run: nerfdetector init"));
    console.log(chalk.gray("    if hooks are wired but no events appear, set NERFDETECTOR_DEBUG=1"));
    console.log(chalk.gray("    and check " + logFile));
  }
  console.log("");

  // Recent log tail
  if (existsSync(logFile)) {
    try {
      const lines = readFileSync(logFile, "utf-8").trim().split("\n").slice(-8);
      if (lines.length > 0) {
        console.log(chalk.gray("  recent log:"));
        for (const l of lines) console.log(chalk.gray("    " + l));
        console.log("");
      }
    } catch {}
  }
}
