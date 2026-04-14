#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { computeAttribution, submitVote } from "./vote.js";
import { printStatus } from "./status.js";
import { ingest } from "./ingest.js";
import { getRecentEvents } from "./store/db.js";

const program = new Command();

program
  .name("nerfdetector")
  .description("is your model nerfed? monitor crowdsourced real-time model performance.")
  .version("0.1.0");

// Default: run init
program
  .action(async () => {
    const { runInit } = await import("./init.js");
    await runInit();
  });

// Help
program
  .command("help")
  .description("show help")
  .action(() => {
    program.outputHelp();
  });

// Init — detect tools, install hooks, print trust boundary
program
  .command("init")
  .description("detect AI tools and install hooks")
  .action(async () => {
    const { runInit } = await import("./init.js");
    await runInit();
  });

// Uninstall — remove all hooks cleanly
program
  .command("uninstall")
  .description("remove nerfdetector hooks from all tools")
  .action(async () => {
    const { runUninstall } = await import("./init.js");
    await runUninstall();
  });

// Quick status (non-interactive)
program
  .command("status")
  .description("show your session + global model status")
  .action(async () => {
    await printStatus();
  });

// Report — one-shot vote with direction prompt
program
  .command("report")
  .description("report how your current session is going")
  .option("--fine", "report as working well")
  .option("--mid", "report as mediocre")
  .option("--nerfed", "report as nerfed")
  .action(async (opts) => {
    const context = computeAttribution();

    if (!context.hasEvents) {
      console.log("");
      console.log(chalk.yellow("  ⚠ no AI activity in the last hour"));
      console.log(chalk.gray("  use an AI coding tool first, then report"));
      console.log("");
      process.exit(0);
    }

    const entries = Object.entries(context.attribution)
      .sort((a, b) => b[1] - a[1])
      .map(([m, w]) => `${m} (${Math.round(w * 100)}%)`)
      .join(" + ");
    const meta = context.sessionMeta;

    console.log("");
    console.log(chalk.bold("  your session"));
    console.log(chalk.gray("  ──────────────────────────"));
    console.log(`  ${entries}`);
    console.log(chalk.gray(
      `  ${meta.callCount} calls · ${meta.errorCount} errors` +
      (meta.toolFailCount ? ` · ${meta.toolFailCount} tool fails` : "")
    ));
    console.log("");

    let direction: 1 | 0 | -1;

    if (opts.fine) {
      direction = 1;
    } else if (opts.mid) {
      direction = 0;
    } else if (opts.nerfed) {
      direction = -1;
    } else {
      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.white("  how was it? ") + chalk.green("[f]") + " fine  " + chalk.yellow("[m]") + " mid  " + chalk.red("[n]") + " nerfed  ", (a) => {
          rl.close();
          resolve(a.trim().toLowerCase());
        });
      });

      if (answer === "f" || answer === "fine") direction = 1;
      else if (answer === "m" || answer === "mid") direction = 0;
      else if (answer === "n" || answer === "nerfed") direction = -1;
      else {
        console.log(chalk.gray("  skipped"));
        console.log("");
        process.exit(0);
      }
    }

    const result = await submitVote(direction, context);

    if (result.ok) {
      const label = direction === 1 ? chalk.green("fine") : direction === 0 ? chalk.yellow("mid") : chalk.red("nerfed");
      console.log(`  ${chalk.green("✓")} reported as ${label}`);
      console.log(chalk.gray("  live at nerfdetector.com"));
    } else {
      console.log(chalk.red(`  ✗ ${result.error}`));
    }
    console.log("");
  });

// Export local events for privacy auditing
program
  .command("export")
  .description("dump local events as JSON (verify what data the agent collects)")
  .option("--hours <n>", "hours of history to export", "24")
  .action((opts) => {
    const hours = parseInt(opts.hours, 10) || 24;
    const events = getRecentEvents(hours * 60 * 60 * 1000);

    if (events.length === 0) {
      console.log("");
      console.log(chalk.gray("  no events in the last " + hours + "h"));
      console.log("");
      return;
    }

    console.log(JSON.stringify(events, null, 2));
    console.error("");
    console.error(chalk.gray(`  ${events.length} events exported (last ${hours}h)`));
    console.error(chalk.gray("  fields: id, ts, tool, model, event_type, duration_ms, status, tool_ok"));
    console.error(chalk.gray("  no prompts, responses, file paths, or code — metadata only"));
    console.error("");
  });

// Internal: hook ingest (hidden from --help)
program
  .command("_ingest <tool>", { hidden: true })
  .action(async (tool: string) => {
    await ingest(tool);
  });

// Internal: session end hook — auto-sends telemetry + prints vote nudge
program
  .command("_session-end", { hidden: true })
  .action(async () => {
    const { handleSessionEnd } = await import("./session-end.js");
    await handleSessionEnd();
  });

program.parseAsync().catch((err) => {
  console.error(chalk.red(`  error: ${err.message || err}`));
  process.exit(1);
});
