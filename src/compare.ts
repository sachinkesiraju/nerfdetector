import chalk from "chalk";
import { getDb, getEventsForSession, type EventRow } from "./store/db.js";
import { buildFingerprint } from "./fingerprint.js";
import { normalizeModelId } from "./models.js";
import { scoreSession, type Fingerprint } from "./analysis/score.js";

function resolveSession(prefix: string): string | null {
  if (prefix.length < 4) return null;
  const db = getDb();
  const matches = db.prepare(
    `SELECT DISTINCT session_id FROM events WHERE session_id LIKE ? LIMIT 2`
  ).all(prefix + "%") as Array<{ session_id: string }>;
  if (matches.length === 1) return matches[0].session_id;
  const exact = db.prepare(`SELECT 1 FROM events WHERE session_id = ? LIMIT 1`).get(prefix);
  return exact ? prefix : null;
}

interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number;
  model: string;
  fp: Fingerprint;
  vote: string | null;
}

function summarize(idPrefix: string): SessionSummary | null {
  const id = resolveSession(idPrefix);
  if (!id) return null;
  const events = getEventsForSession(id);
  if (events.length === 0) return null;

  const startedAt = Math.min(...events.map((e) => e.ts));
  const endedAt = Math.max(...events.map((e) => e.ts));

  // Pick primary model
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== "tool_use") continue;
    const m = normalizeModelId(e.model);
    if (m === "unknown") continue;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  let model = "";
  let best = 0;
  for (const [m, n] of counts) if (n > best) { best = n; model = m; }

  const fp = buildFingerprint(events);
  const voteRow = events.find((e) => e.event_type === "vote");
  return { id, startedAt, endedAt, model, fp, vote: voteRow?.status ?? null };
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function deltaDuration(aS: number, bS: number, goodDir: "up" | "down"): string {
  const d = bS - aS;
  if (Math.abs(d) < 60) return chalk.gray("·");
  const arrow = d > 0 ? "▲" : "▼";
  const isGood = (goodDir === "up" && d > 0) || (goodDir === "down" && d < 0);
  const color = isGood ? chalk.green : chalk.red;
  const abs = Math.abs(d);
  const lbl = abs < 3600 ? `${Math.round(abs / 60)}m`
            : abs < 86400 ? `${Math.round(abs / 3600)}h`
            : `${Math.round(abs / 86400)}d`;
  return color(`${arrow} ${d > 0 ? "+" : "-"}${lbl}`);
}

function shortModel(m: string): string {
  // Strip provider prefix-like noise and trim long ids for column display
  return m.length > 14 ? m.slice(0, 13) + "…" : m;
}

function fmtVote(v: string | null): string {
  if (v === "1") return chalk.green("🟢 fine");
  if (v === "0") return chalk.yellow("🟡 mid");
  if (v === "-1") return chalk.red("🔴 nerfed");
  return chalk.gray("(no vote)");
}

interface Row {
  label: string;
  a: string;
  b: string;
  delta: string;
}

function row(label: string, a: string, b: string, delta: string): Row {
  return { label, a, b, delta };
}

function deltaPct(a: number | null, b: number | null, goodDir: "up" | "down"): string {
  if (a == null || b == null) return chalk.gray("—");
  const d = b - a;
  if (Math.abs(d) < 0.005) return chalk.gray("·");
  const arrow = d > 0 ? "▲" : "▼";
  const isGood = (goodDir === "up" && d > 0) || (goodDir === "down" && d < 0);
  const color = isGood ? chalk.green : chalk.red;
  return color(`${arrow} ${d > 0 ? "+" : ""}${Math.round(d * 100)}pts`);
}

function deltaNum(a: number | null, b: number | null, goodDir: "up" | "down", suffix = ""): string {
  if (a == null || b == null) return chalk.gray("—");
  const d = b - a;
  if (Math.abs(d) < 0.05) return chalk.gray("·");
  const arrow = d > 0 ? "▲" : "▼";
  const isGood = (goodDir === "up" && d > 0) || (goodDir === "down" && d < 0);
  const color = isGood ? chalk.green : chalk.red;
  return color(`${arrow} ${d > 0 ? "+" : ""}${d.toFixed(1)}${suffix}`);
}

function deltaInt(a: number, b: number, goodDir: "up" | "down"): string {
  const d = b - a;
  if (d === 0) return chalk.gray("·");
  const arrow = d > 0 ? "▲" : "▼";
  const isGood = (goodDir === "up" && d > 0) || (goodDir === "down" && d < 0);
  const color = isGood ? chalk.green : chalk.red;
  return color(`${arrow} ${d > 0 ? "+" : ""}${d}`);
}

export function runCompare(idA: string, idB: string) {
  const a = summarize(idA);
  const b = summarize(idB);

  console.log("");
  if (!a) {
    console.log(chalk.yellow(`  ⚠ no session matching '${idA}'`));
    console.log("");
    return;
  }
  if (!b) {
    console.log(chalk.yellow(`  ⚠ no session matching '${idB}'`));
    console.log("");
    return;
  }

  console.log(chalk.bold("  comparing sessions"));
  console.log(chalk.gray("  ──────────────────────────────────"));
  console.log("");

  const colW = 16;
  const header = `${"".padEnd(20)}${fmtDate(a.startedAt).padStart(colW)}${fmtDate(b.startedAt).padStart(colW)}${"delta".padStart(colW)}`;
  console.log(chalk.gray(header));

  const rows: Row[] = [
    row("model",       shortModel(a.model || "?"), shortModel(b.model || "?"), chalk.gray("·")),
    row("duration",    fmtDuration(a.fp.sessionDurationS), fmtDuration(b.fp.sessionDurationS),
                       deltaDuration(a.fp.sessionDurationS, b.fp.sessionDurationS, "down")),
    row("actions",     String(a.fp.toolCallCount), String(b.fp.toolCallCount),
                       deltaInt(a.fp.toolCallCount, b.fp.toolCallCount, "up")),
    row("success rate", pct(1 - a.fp.toolFailRate), pct(1 - b.fp.toolFailRate),
                       deltaPct(1 - a.fp.toolFailRate, 1 - b.fp.toolFailRate, "up")),
    row("retry rate",   pct(a.fp.retryRate), pct(b.fp.retryRate),
                       deltaPct(a.fp.retryRate, b.fp.retryRate, "down")),
    row("loops",        String(a.fp.loops), String(b.fp.loops),
                       deltaInt(a.fp.loops, b.fp.loops, "down")),
    row("resteers",     String(a.fp.resteers), String(b.fp.resteers),
                       deltaInt(a.fp.resteers, b.fp.resteers, "down")),
    row("top fail tool", a.fp.topFailingTool ?? "—", b.fp.topFailingTool ?? "—", chalk.gray("·")),
    row("vote",         stripAnsi(fmtVote(a.vote)), stripAnsi(fmtVote(b.vote)), chalk.gray("·")),
  ];
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(18)}${r.a.padStart(colW)}${r.b.padStart(colW)}${r.delta.padStart(colW + ansiPad(r.delta))}`);
  }
  console.log("");

  // Verdict
  const aGood = (1 - a.fp.toolFailRate);
  const bGood = (1 - b.fp.toolFailRate);
  if (Math.abs(bGood - aGood) >= 0.1) {
    if (bGood > aGood) {
      console.log(chalk.green(`  ✓ session 2 was meaningfully better across success rate`));
    } else {
      console.log(chalk.red(`  ✗ session 2 was meaningfully worse on success rate`));
    }
  }
  console.log("");
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// ── Lightweight ANSI helpers (don't pull a dep) ─────────

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function ansiPad(s: string): number {
  return s.length - stripAnsi(s).length;
}
