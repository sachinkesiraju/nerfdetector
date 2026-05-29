import chalk from "chalk";
import type { TokenUsage } from "./analysis/score.js";
import type { StatusTier } from "./models.js";

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

/**
 * Render 0..1 values as a unicode sparkline using *absolute* scaling
 * (0 → lowest bar, 1 → highest). Absolute — not min/max-normalized — so a
 * flatly-bad series reads low instead of being stretched to look mid.
 * Returns "" for empty input. Takes the most recent `width` values.
 */
export function sparkline(values: number[] | undefined, width = 12): string {
  if (!values || values.length === 0) return "";
  return values
    .slice(-width)
    .map((v) => {
      const i = Math.round(Math.max(0, Math.min(1, v)) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[i];
    })
    .join("");
}

/** chalk color for a status tier — fine=green, struggling=yellow, nerfed=red. */
export function tierColor(tier: StatusTier): (s: string) => string {
  return tier === "fine" ? chalk.green : tier === "struggling" ? chalk.yellow : chalk.red;
}

/** Compact token count: 980 → "980", 48200 → "48.2k", 1_240_000 → "1.24M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * A proportion gauge: `████████████░░░░░░░░`. Filled cells are colored by
 * how good `rate` is for cache efficiency (more cache reuse = better).
 */
function gauge(rate: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, rate));
  const filled = Math.round(clamped * width);
  const color = clamped >= 0.7 ? chalk.green : clamped >= 0.4 ? chalk.yellow : chalk.red;
  return color("█".repeat(filled)) + chalk.gray("░".repeat(width - filled));
}

/**
 * In-session token analytics block. Returns rendered lines (caller owns the
 * surrounding blank lines). Empty array when there's no token data — live
 * hooks don't carry usage, only backfilled/transcript sessions do.
 *
 *   token usage · 372.1k in → 12.9k out
 *     cache hit  ██████████████░░░░░░  84%
 *     context    359.2k   48.2k new · 311.0k cached
 */
export function renderTokens(t: TokenUsage, indent = "  "): string[] {
  const cached = t.cacheRead;
  const fresh = t.input;
  const contextIn = fresh + cached;
  if (contextIn === 0 && t.output === 0) return [];

  const lines: string[] = [];
  lines.push(
    `${indent}${chalk.gray("token usage")} · ${fmtTokens(contextIn)} in ${chalk.gray("→")} ${fmtTokens(t.output)} out`
  );
  if (contextIn > 0) {
    const pct = Math.round(t.cacheHitRate * 100);
    lines.push(`${indent}  cache hit  ${gauge(t.cacheHitRate)}  ${pct}%`);
    lines.push(
      `${indent}  context    ${fmtTokens(contextIn).padStart(7)}   ` +
        chalk.gray(`${fmtTokens(fresh)} new · ${fmtTokens(cached)} cached`)
    );
  }
  return lines;
}
