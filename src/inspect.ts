import chalk from "chalk";
import { getRecentEvents, getBaseline } from "./store/db.js";
import { computeAttribution } from "./vote.js";
import { buildFingerprint, fingerprintConsent } from "./fingerprint.js";
import { normalizeModelId } from "./models.js";

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtDelta(n: number | null, unit: "pct" | "s" | "x", goodDirection: "up" | "down"): string {
  if (n == null) return chalk.gray("—");
  const arrow = n > 0 ? "▲" : n < 0 ? "▼" : "·";
  const isGood = (goodDirection === "up" && n > 0) || (goodDirection === "down" && n < 0);
  const color = Math.abs(n) < 0.01 ? chalk.gray : (isGood ? chalk.green : chalk.red);
  const body =
    unit === "pct" ? `${(n > 0 ? "+" : "")}${Math.round(n * 100)}pts` :
    unit === "s"   ? `${(n > 0 ? "+" : "")}${n.toFixed(1)}s` :
                     `${(n > 0 ? "+" : "")}${n.toFixed(2)}x`;
  return color(`${arrow} ${body}`);
}

export function runInspect() {
  const events = getRecentEvents();
  const ctx = computeAttribution(events);

  console.log("");
  if (!ctx.hasEvents) {
    console.log(chalk.yellow("  ⚠ no AI activity in the last 15 min"));
    console.log(chalk.gray("  start a session, then re-run `nerfdetector inspect`"));
    console.log("");
    return;
  }

  const fp = buildFingerprint(events);

  const entries = Object.entries(ctx.attribution)
    .sort((a, b) => b[1] - a[1])
    .map(([m, w]) => `${m} (${Math.round(w * 100)}%)`)
    .join(" + ");

  console.log(chalk.bold(`  current session — ${entries}`));
  console.log(chalk.gray("  ─────────────────────────────────────────"));
  console.log("");
  console.log(`  duration       ${fmtDuration(fp.sessionDurationS)}`);
  console.log(`  tool calls     ${fp.toolCallCount}`);
  console.log(`  failures       ${Math.round(fp.toolFailRate * fp.toolCallCount)} (${fmtPct(fp.toolFailRate)})`);
  console.log(`  retries        ${Math.round(fp.retryRate * fp.toolCallCount)} (${fmtPct(fp.retryRate)})`);
  console.log(`  loops          ${fp.loops}`);
  console.log(`  resteers       ${fp.resteers}`);
  console.log(`  wasted calls   ${fp.wastedCalls}` + (fp.wastedCalls > 0 ? chalk.gray(`  (duplicate tool calls)`) : ""));
  if (fp.topFailingTool) {
    console.log(`  top fail tool  ${fp.topFailingTool}`);
  }

  // Token usage (when available — backfilled sessions have it; live hooks don't yet)
  if (fp.tokens.input > 0 || fp.tokens.output > 0) {
    console.log("");
    console.log(`  input tokens   ${fmtTokens(fp.tokens.input)}`);
    console.log(`  output tokens  ${fmtTokens(fp.tokens.output)}`);
    console.log(`  cache read     ${fmtTokens(fp.tokens.cacheRead)}` + chalk.gray(`  (${fmtPct(fp.tokens.cacheHitRate)} cache hit rate)`));
  }
  console.log("");

  const d = fp.deviationFromBaseline;
  const hasAnyBaseline = d.successRate != null || d.retryRate != null || d.latency != null;
  if (hasAnyBaseline) {
    console.log(chalk.gray("  vs your 7-day norm:"));
    if (d.successRate != null) console.log(`    success rate   ${fmtDelta(d.successRate, "pct", "up")}`);
    if (d.retryRate != null)   console.log(`    retry rate     ${fmtDelta(d.retryRate, "pct", "down")}`);
    if (d.latency != null)     console.log(`    latency        ${fmtDelta(d.latency, "s", "down")}`);
    console.log("");
  } else {
    console.log(chalk.gray("  no baselines yet (need 3+ scored sessions per model)"));
    console.log("");
  }

  console.log(chalk.gray("  fingerprint that would be sent on vote:"));
  console.log("");
  for (const ln of JSON.stringify(fp, null, 2).split("\n")) console.log("  " + ln);
  console.log("");

  const consent = fingerprintConsent();
  if (consent === "skip") {
    console.log(chalk.yellow("  ⚠ fingerprint sharing is currently OFF"));
    console.log(chalk.gray("    (set via prior consent or NERFDETECTOR_NO_FINGERPRINT=1)"));
  } else if (consent === "send") {
    console.log(chalk.gray("  fingerprint sharing is on. NERFDETECTOR_NO_FINGERPRINT=1 to opt out per-session"));
  } else {
    console.log(chalk.gray("  you'll be asked to confirm the first time you vote"));
  }
  console.log("");
}
