import chalk from "chalk";
import { computeAttribution, fetchGlobalStatus } from "./vote.js";
import type { ModelStatus, StatusTier } from "./models.js";

function tierEmoji(tier: StatusTier): string {
  switch (tier) {
    case "fine": return "🟢";
    case "struggling": return "🟡";
    case "nerfed": return "🔴";
  }
}

function pct(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n * 100)}%`;
}

const TIER_SORT: Record<string, number> = {
  nerfed: 0, struggling: 1, fine: 2,
};

export async function printStatus() {
  const context = computeAttribution();

  console.log("");
  console.log(chalk.bold("  your session (last 15 min)"));
  console.log(chalk.gray("  ──────────────────────────"));

  if (!context.hasEvents) {
    console.log(chalk.gray("  no AI activity detected"));
  } else {
    const entries = Object.entries(context.attribution).sort((a, b) => b[1] - a[1]);
    for (const [modelId, weight] of entries) {
      console.log(`  ${modelId.padEnd(20)} ${Math.round(weight * 100)}%`);
    }
    const meta = context.sessionMeta;
    console.log(chalk.gray(
      `  ${meta.callCount} calls` +
      (meta.errorCount > 0 ? ` · ${meta.errorCount} errors` : "") +
      (meta.toolFailCount ? ` · ${meta.toolFailCount} tool fails` : "")
    ));
  }

  console.log("");
  console.log(chalk.bold("  global"));
  console.log(chalk.gray("  ──────────────────────────"));

  const data = await fetchGlobalStatus();
  if (!data?.models) {
    console.log(chalk.gray("  could not connect to nerfdetector.com"));
    console.log("");
    return;
  }

  const sorted = [...data.models].sort(
    (a: ModelStatus, b: ModelStatus) =>
      (TIER_SORT[a.tier] ?? 99) - (TIER_SORT[b.tier] ?? 99)
  );

  for (const m of sorted) {
    const emoji = tierEmoji(m.tier);
    const name = m.displayName.slice(0, 20).padEnd(20);
    const sent = pct(m.sentimentScore).padStart(4);
    const health = pct(m.healthScore).padStart(4);
    const sessions = String(m.voteCount + m.sessionCount).padStart(4);
    console.log(`  ${emoji} ${name}  ${sent} sentiment · ${health} telemetry · ${sessions} sessions`);
  }

  console.log("");
}
