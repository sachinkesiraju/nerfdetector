import chalk from "chalk";
import { getDb, getBaseline, getEventsInRange } from "./store/db.js";

function bar(pct: number, width: number = 16): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct >= 90 ? chalk.green : pct >= 70 ? chalk.yellow : chalk.red;
  return color("█".repeat(filled)) + chalk.gray("░".repeat(empty));
}

export function printHistory(days: number = 7) {
  const db = getDb();
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  const toolEvents = db.prepare(
    `SELECT * FROM events WHERE ts > ? AND event_type = 'tool_use' ORDER BY ts ASC`
  ).all(cutoff) as any[];

  const voteEvents = db.prepare(
    `SELECT * FROM events WHERE ts > ? AND event_type = 'vote' ORDER BY ts ASC`
  ).all(cutoff) as any[];

  if (toolEvents.length === 0) {
    console.log("");
    console.log(chalk.gray(`  no activity in the last ${days} days`));
    console.log("");
    return;
  }

  // Group by model
  const allModels = new Set<string>(toolEvents.map((e: any) => e.model));

  console.log("");
  console.log(chalk.bold("  your history") + chalk.gray(` · last ${days} days`));
  console.log("");

  for (const model of allModels) {
    const modelToolEvents = toolEvents.filter((e: any) => e.model === model);
    const modelVoteEvents = voteEvents.filter((e: any) => e.model === model);

    // Compute current period metrics
    const actions = modelToolEvents.length;
    const failed = modelToolEvents.filter((e: any) => e.tool_ok === 0).length;
    const successRate = actions > 0 ? (actions - failed) / actions : 1;

    let retries = 0;
    let lastTool: string | null = null;
    let streak = 0;
    for (const e of modelToolEvents) {
      if (e.tool_name === lastTool) { streak++; if (streak >= 2) retries++; }
      else streak = 1;
      lastTool = e.tool_name;
    }
    const retryRate = actions > 0 ? retries / actions : 0;

    // Latency: median gap between consecutive events (in seconds)
    const gaps: number[] = [];
    for (let i = 1; i < modelToolEvents.length; i++) {
      const gap = (modelToolEvents[i].ts - modelToolEvents[i - 1].ts) / 1000;
      if (gap > 0 && gap < 300) gaps.push(gap); // ignore gaps > 5min (session breaks)
    }
    gaps.sort((a, b) => a - b);
    const medianLatency = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : null;

    // Nerfed rate
    const nerfedCount = modelVoteEvents.filter((v: any) => v.status === "-1").length;
    const totalVotes = modelVoteEvents.length;
    const nerfedRate = totalVotes > 0 ? nerfedCount / totalVotes : null;

    // Get baselines (30d averages)
    const bl_success = getBaseline(model, "success_rate");
    const bl_retry = getBaseline(model, "retry_rate");
    const bl_latency = getBaseline(model, "latency");
    const bl_nerfed = getBaseline(model, "nerfed_rate");

    const sessionCount = modelToolEvents.length;
    console.log(chalk.bold(`  ${model}`) + chalk.gray(` · ${sessionCount} actions`));
    console.log("");

    // Baseline comparison rows
    // Helper: format a metric row with aligned columns
    //   label (16 chars)  baseline (6 chars) → current (6 chars)  delta
    function metricRow(label: string, baselineStr: string | null, currentStr: string, delta: string) {
      const lbl = label.padEnd(16);
      // Only show baseline → current when they're meaningfully different
      if (baselineStr != null && baselineStr !== currentStr) {
        return `  ${lbl}${chalk.gray(baselineStr.padStart(6))} → ${currentStr.padStart(6)}  ${delta}`;
      }
      return `  ${lbl}${currentStr.padStart(6)}`;
    }

    const rows: string[] = [];

    // Success rate
    {
      const cur = Math.round(successRate * 100);
      const bl = bl_success?.avg_30d != null ? Math.round(bl_success.avg_30d * 100) : null;
      if (bl != null) {
        const diff = cur - bl;
        const delta = diff < -5 ? chalk.red(`▼ ${Math.abs(diff)}pts`) : diff > 5 ? chalk.green(`▲ ${diff}pts`) : chalk.gray("—");
        const color = cur < bl - 10 ? chalk.red : chalk.white;
        rows.push(metricRow("success rate", bl + "%", color(cur + "%"), delta));
      } else {
        rows.push(metricRow("success rate", null, cur + "%", ""));
      }
    }

    // Retry rate
    {
      const cur = Math.round(retryRate * 100);
      const bl = bl_retry?.avg_30d != null ? Math.round(bl_retry.avg_30d * 100) : null;
      if (bl != null && (cur > 3 || bl > 3)) {
        const ratio = bl > 0 ? cur / bl : 0;
        const delta = ratio > 1.5 ? chalk.red(`▲ ${ratio.toFixed(1)}x`) : ratio < 0.7 ? chalk.green(`▼`) : chalk.gray("—");
        const color = cur > bl + 10 ? chalk.red : chalk.white;
        rows.push(metricRow("retry rate", bl + "%", color(cur + "%"), delta));
      } else if (cur > 3) {
        rows.push(metricRow("retry rate", null, cur + "%", ""));
      }
    }

    // Latency
    if (medianLatency != null) {
      const cur = medianLatency;
      const bl = bl_latency?.avg_30d;
      if (bl != null && bl > 0) {
        const ratio = cur / bl;
        const delta = ratio > 1.5 ? chalk.red(`▲ ${ratio.toFixed(1)}x slower`) : ratio < 0.7 ? chalk.green(`▼ faster`) : chalk.gray("—");
        const color = ratio > 1.5 ? chalk.red : chalk.white;
        rows.push(metricRow("latency", bl.toFixed(1) + "s", color(cur.toFixed(1) + "s"), delta));
      } else {
        rows.push(metricRow("latency", null, cur.toFixed(1) + "s", ""));
      }
    }

    // Nerfed rate
    if (nerfedRate != null && totalVotes >= 2) {
      const cur = Math.round(nerfedRate * 100);
      const bl = bl_nerfed?.avg_30d != null ? Math.round(bl_nerfed.avg_30d * 100) : null;
      if (bl != null && bl > 0) {
        const ratio = cur / bl;
        if (ratio > 1.5) {
          rows.push(metricRow("nerfed rate", bl + "%", chalk.red(cur + "%"), chalk.red(`▲ ${ratio.toFixed(1)}x more`)));
        } else if (ratio < 0.7) {
          rows.push(metricRow("nerfed rate", bl + "%", chalk.green(cur + "%"), chalk.green("▼ improving")));
        }
      } else if (cur > 30) {
        rows.push(metricRow("nerfed rate", null, chalk.red(cur + "%"), ""));
      }
    }

    for (const row of rows) console.log(row);

    // Update baselines with current period data
    // Baselines are updated by session-end, not here — history is read-only

    console.log("");

    // ── Daily timeline ─────────────────────────────
    const byDay = new Map<string, { actions: number; failed: number; retries: number; lastTool: string | null; streak: number }>();
    for (const ev of modelToolEvents) {
      const date = new Date(ev.ts).toISOString().slice(0, 10);
      if (!byDay.has(date)) byDay.set(date, { actions: 0, failed: 0, retries: 0, lastTool: null, streak: 0 });
      const m = byDay.get(date)!;
      m.actions++;
      if (ev.tool_ok === 0) m.failed++;
      if (ev.tool_name === m.lastTool) { m.streak++; if (m.streak >= 2) m.retries++; }
      else m.streak = 1;
      m.lastTool = ev.tool_name;
    }

    const votesByDay = new Map<string, number[]>();
    for (const ev of modelVoteEvents) {
      const date = new Date(ev.ts).toISOString().slice(0, 10);
      if (!votesByDay.has(date)) votesByDay.set(date, []);
      votesByDay.get(date)!.push(parseInt(ev.status, 10));
    }

    const sortedDays = [...byDay.keys()].sort();
    if (sortedDays.length > 0) {
      // Columns: [1]dev [7]date [24]bar+pct [5]actions [6]retries [vote]
      //          1      7       16 + 4 = 20   5          6
      console.log(chalk.gray("          ") + chalk.gray("date".padEnd(8)) + chalk.gray("success".padEnd(21)) + chalk.gray("actions".padStart(7)) + chalk.gray("retries".padStart(9)) + chalk.gray("  vote"));
      console.log(chalk.gray("  ──────────────────────────────────────────────────────────────"));

      for (const date of sortedDays) {
        const m = byDay.get(date)!;
        const sPct = m.actions > 0 ? Math.round(((m.actions - m.failed) / m.actions) * 100) : 100;
        const rPct = m.actions > 0 ? Math.round((m.retries / m.actions) * 100) : 0;

        let devMarker = "  ";
        if (bl_success?.avg_7d != null) {
          const sRate = m.actions > 0 ? (m.actions - m.failed) / m.actions : 1;
          if (bl_success.avg_7d - sRate > 0.15) devMarker = chalk.red("▼ ");
          else if (sRate - bl_success.avg_7d > 0.1) devMarker = chalk.green("▲ ");
        }

        const retryColor = rPct > 15 ? chalk.red : rPct > 5 ? chalk.yellow : chalk.gray;

        const dayVotes = votesByDay.get(date) ?? [];
        let voteStr = chalk.gray("—");
        if (dayVotes.length > 0) {
          const last = dayVotes[dayVotes.length - 1];
          const emoji = last === 1 ? "🟢" : last === 0 ? "🟡" : "🔴";
          const label = last === 1 ? chalk.green("fine") : last === 0 ? chalk.yellow("mid") : chalk.red("nerfed");
          voteStr = emoji + " " + label;
          if (dayVotes.length > 1) voteStr += chalk.gray(` +${dayVotes.length - 1}`);
        }

        const d = new Date(date + "T00:00:00");
        const monthDay = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

        console.log(
          devMarker +
          chalk.white(monthDay.padEnd(8)) +
          bar(sPct) + " " + chalk.white(String(sPct).padStart(3) + "%") +
          chalk.white(String(m.actions).padStart(7)) +
          retryColor(String(rPct).padStart(7) + "%") +
          "  " + voteStr
        );
      }

      console.log("");
    }

    // ── Insights ───────────────────────────────────
    if (totalVotes >= 3) {
      const insights: string[] = [];

      // For each vote, compute the session metrics (15min window before vote)
      const voteWithMetrics = modelVoteEvents.map((v: any) => {
        const windowStart = v.ts - 15 * 60 * 1000;
        const events = getEventsInRange(windowStart, v.ts)
          .filter((e: any) => e.event_type === "tool_use" && e.model === model);
        if (events.length < 3) return null;

        const acts = events.length;
        const fails = events.filter((e: any) => e.tool_ok === 0).length;
        let retries = 0;
        let lt: string | null = null;
        for (const e of events) { if (e.tool_name === lt) retries++; lt = e.tool_name; }

        const sizes = events.filter((e: any) => e.response_size != null).map((e: any) => e.response_size as number);
        sizes.sort((a, b) => a - b);
        const medianSize = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : null;

        const gaps: number[] = [];
        for (let i = 1; i < events.length; i++) {
          const g = (events[i].ts - events[i - 1].ts) / 1000;
          if (g > 0 && g < 300) gaps.push(g);
        }
        gaps.sort((a, b) => a - b);
        const medianGap = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : null;

        return {
          direction: parseInt(v.status, 10),
          hour: new Date(v.ts).getHours(),
          successRate: (acts - fails) / acts,
          retryRate: retries / acts,
          medianSize,
          latency: medianGap,
        };
      }).filter((v: any) => v != null) as any[];

      const nerfedSessions = voteWithMetrics.filter((v: any) => v.direction === -1);
      const fineSessions = voteWithMetrics.filter((v: any) => v.direction === 1);

      // Insight: retry multiplier nerfed vs fine
      if (nerfedSessions.length >= 2 && fineSessions.length >= 2) {
        const avgRetryNerfed = nerfedSessions.reduce((s: number, v: any) => s + v.retryRate, 0) / nerfedSessions.length;
        const avgRetryFine = fineSessions.reduce((s: number, v: any) => s + v.retryRate, 0) / fineSessions.length;
        if (avgRetryFine > 0.01 && avgRetryNerfed / avgRetryFine > 1.5) {
          insights.push(`${(avgRetryNerfed / avgRetryFine).toFixed(1)}× more retries when you vote nerfed vs fine`);
        }
      }

      // Insight: response size correlation with nerfed
      if (nerfedSessions.length >= 2) {
        const nerfedWithSmallResp = nerfedSessions.filter((v: any) => v.medianSize != null);
        if (nerfedWithSmallResp.length >= 2) {
          const allSizes = voteWithMetrics.filter((v: any) => v.medianSize != null).map((v: any) => v.medianSize as number);
          allSizes.sort((a, b) => a - b);
          const threshold = allSizes[Math.floor(allSizes.length * 0.35)]; // bottom 35th percentile
          if (threshold > 0) {
            const nerfedBelowThreshold = nerfedSessions.filter((v: any) => v.medianSize != null && v.medianSize <= threshold).length;
            const correlationPct = Math.round((nerfedBelowThreshold / nerfedSessions.length) * 100);
            if (correlationPct >= 60) {
              insights.push(`nerfed votes correlate ${correlationPct}% with short responses (< ${Math.round(threshold)} chars)`);
            }
          }
        }
      }

      // Insight: time-of-day pattern
      if (nerfedSessions.length >= 3) {
        const buckets: Record<string, { total: number; nerfed: number }> = {
          morning: { total: 0, nerfed: 0 },
          afternoon: { total: 0, nerfed: 0 },
          evening: { total: 0, nerfed: 0 },
          night: { total: 0, nerfed: 0 },
        };
        for (const v of voteWithMetrics) {
          const h = v.hour;
          const bucket = h >= 6 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night";
          buckets[bucket].total++;
          if (v.direction === -1) buckets[bucket].nerfed++;
        }
        const worst = Object.entries(buckets)
          .filter(([_, b]) => b.total >= 2)
          .sort((a, b) => (b[1].nerfed / b[1].total) - (a[1].nerfed / a[1].total))[0];
        if (worst && worst[1].total >= 2) {
          const pct = Math.round((worst[1].nerfed / worst[1].total) * 100);
          if (pct >= 50) {
            insights.push(`${pct}% of your ${worst[0]} sessions end with nerfed`);
          }
        }
      }

      // Insight: baseline shift detection
      if (bl_success?.avg_30d != null && bl_success?.avg_7d != null) {
        const shift = Math.round((bl_success.avg_7d - bl_success.avg_30d) * 100);
        if (Math.abs(shift) >= 10) {
          // Find first day where success dropped below 30d avg
          const threshold = bl_success.avg_30d;
          let shiftStart: string | null = null;
          for (const date of sortedDays) {
            const m = byDay.get(date);
            if (!m) continue;
            const dayRate = m.actions > 0 ? (m.actions - m.failed) / m.actions : 1;
            if (dayRate < threshold - 0.1) {
              shiftStart = date;
              break;
            }
          }
          if (shiftStart && shift < -10) {
            const d = new Date(shiftStart + "T00:00:00");
            const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
            insights.push(`your baseline shifted ${shift}% since ${label}`);
          }
        }
      }

      if (insights.length > 0) {
        console.log(chalk.bold("  insights") + chalk.gray(` · ${totalVotes} voted sessions`));
        for (const insight of insights) {
          console.log(chalk.gray("  • ") + insight);
        }
        console.log("");
      }
    }
  }
}
