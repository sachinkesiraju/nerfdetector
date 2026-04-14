import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { getDataDir } from "./store/db.js";
import { getDeviceId } from "./device.js";

const HOME = homedir();

function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

// ── Generic JSON config hook merge/remove ───────────────────────

interface HookConfig {
  /** Path to the JSON config file */
  configPath: string;
  /** Map of event name → command to install */
  hooks: Record<string, string>;
  /** All commands we own (for uninstall matching) */
  allCommands: string[];
  /** How to structure a hook entry in this tool's format */
  makeEntry: (command: string) => any;
  /** How to check if a rule already has our command */
  hasCommand: (rule: any, command: string) => boolean;
  /** Key in the config object that holds hooks */
  hooksKey: string;
}

function mergeHooks(cfg: HookConfig): boolean {
  let config: any = {};
  if (existsSync(cfg.configPath)) {
    try {
      config = JSON.parse(readFileSync(cfg.configPath, "utf-8"));
    } catch {
      console.log(chalk.yellow(`    ⚠ could not parse ${cfg.configPath} — skipping`));
      return false;
    }
  }

  if (!config[cfg.hooksKey]) config[cfg.hooksKey] = {};
  let changed = false;

  for (const [event, command] of Object.entries(cfg.hooks)) {
    if (!config[cfg.hooksKey][event]) config[cfg.hooksKey][event] = [];

    const already = config[cfg.hooksKey][event].some((rule: any) => cfg.hasCommand(rule, command));
    if (already) continue;

    config[cfg.hooksKey][event].push(cfg.makeEntry(command));
    changed = true;
  }

  if (!changed) {
    console.log(chalk.gray("    hooks already installed"));
    return true;
  }

  // Ensure parent dir exists
  const dir = dirname(cfg.configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(cfg.configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return true;
}

function removeHooks(cfg: HookConfig): boolean {
  if (!existsSync(cfg.configPath)) return false;

  try {
    const config = JSON.parse(readFileSync(cfg.configPath, "utf-8"));
    if (!config[cfg.hooksKey]) return false;

    let changed = false;
    for (const event of Object.keys(config[cfg.hooksKey])) {
      const rules = config[cfg.hooksKey][event];
      if (!Array.isArray(rules)) continue;

      const filtered = rules.filter((rule: any) => {
        // Keep rules that don't contain any of our commands
        return !cfg.allCommands.some((cmd) => cfg.hasCommand(rule, cmd));
      });

      if (filtered.length !== rules.length) {
        config[cfg.hooksKey][event] = filtered;
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(cfg.configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    }
    return changed;
  } catch {
    return false;
  }
}

// ── Tool-specific configs ───────────────────────────────────────

function claudeCodeConfig(): HookConfig {
  const ingest = "nerfdetector _ingest claude-code";
  const sessionEnd = "nerfdetector _session-end";
  return {
    configPath: join(HOME, ".claude", "settings.json"),
    hooksKey: "hooks",
    hooks: {
      UserPromptSubmit: ingest,
      PostToolUse: ingest,
      Stop: sessionEnd,
    },
    allCommands: [ingest, sessionEnd],
    makeEntry: (cmd) => ({ hooks: [{ type: "command", command: cmd }] }),
    hasCommand: (rule, cmd) =>
      Array.isArray(rule.hooks) && rule.hooks.some((h: any) => h.command === cmd),
  };
}

function codexCliConfig(): HookConfig {
  // Codex CLI uses ~/.codex/hooks.json
  // Format: { "event_name": [{ "command": "...", "type": "command" }] }
  const ingest = "nerfdetector _ingest codex";
  const sessionEnd = "nerfdetector _session-end";
  return {
    configPath: join(HOME, ".codex", "hooks.json"),
    hooksKey: "hooks",
    hooks: {
      on_agent_tool_call: ingest,
      on_agent_turn_end: sessionEnd,
    },
    allCommands: [ingest, sessionEnd],
    makeEntry: (cmd) => ({ type: "command", command: cmd }),
    hasCommand: (rule, cmd) => rule.command === cmd,
  };
}

function geminiCliConfig(): HookConfig {
  // Gemini CLI uses ~/.gemini/settings.json with hooks key
  // Format similar to Claude Code: { "hooks": { "AfterTool": [{ "hooks": [{ "type": "command", "command": "..." }] }] } }
  const ingest = "nerfdetector _ingest gemini";
  const sessionEnd = "nerfdetector _session-end";
  return {
    configPath: join(HOME, ".gemini", "settings.json"),
    hooksKey: "hooks",
    hooks: {
      AfterTool: ingest,
      SessionEnd: sessionEnd,
    },
    allCommands: [ingest, sessionEnd],
    makeEntry: (cmd) => ({ hooks: [{ type: "command", command: cmd }] }),
    hasCommand: (rule, cmd) =>
      Array.isArray(rule.hooks) && rule.hooks.some((h: any) => h.command === cmd),
  };
}

// ── Tool definitions ────────────────────────────────────────────

interface Tool {
  name: string;
  configDir: string;
  detect: () => boolean;
  hookConfig: () => HookConfig;
}

const TOOLS: Tool[] = [
  {
    name: "Claude Code",
    configDir: join(HOME, ".claude"),
    detect: () => existsSync(join(HOME, ".claude")),
    hookConfig: claudeCodeConfig,
  },
  {
    name: "Codex CLI",
    configDir: join(HOME, ".codex"),
    detect: () => existsSync(join(HOME, ".codex")),
    hookConfig: codexCliConfig,
  },
  {
    name: "Gemini CLI",
    configDir: join(HOME, ".gemini"),
    detect: () => existsSync(join(HOME, ".gemini")),
    hookConfig: geminiCliConfig,
  },
];

// ── Commands ────────────────────────────────────────────────────

export async function runInit() {
  console.log("");
  console.log(chalk.bold("  nerfdetector init"));
  console.log(chalk.gray("  ──────────────────────────"));
  console.log("");

  console.log(chalk.bold("  detecting AI coding tools..."));
  console.log("");

  const detected = TOOLS.filter((t) => t.detect());

  if (detected.length === 0) {
    console.log(chalk.yellow("  no supported tools found."));
    console.log(chalk.gray("  supported: Claude Code, Codex CLI, Gemini CLI"));
    console.log("");
    return;
  }

  for (const tool of detected) {
    console.log(`  found ${chalk.white(tool.name)} at ${chalk.gray(tool.configDir)}`);
  }
  console.log("");

  for (const tool of detected) {
    const yes = await ask(`  install nerfdetector hooks for ${chalk.white(tool.name)}? [y/n] `);
    if (yes) {
      const ok = mergeHooks(tool.hookConfig());
      if (ok) {
        console.log(chalk.green(`    ✓ hooks installed for ${tool.name}`));
      }
    } else {
      console.log(chalk.gray("    skipped"));
    }
    console.log("");
  }

  // Ensure data dir + device ID
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const deviceId = getDeviceId();
  console.log(chalk.gray(`  device id: ${deviceId.slice(0, 8)}...`));
  console.log(chalk.gray(`  data dir:  ${dataDir}`));
  console.log("");

  console.log(chalk.bold("  what gets sent when you report:"));
  console.log(chalk.white("    ✓ which models you used"));
  console.log(chalk.white("    ✓ how many actions succeeded or failed"));
  console.log(chalk.white("    ✓ how often the model retried"));
  console.log("");
  console.log(chalk.bold("  what never gets sent:"));
  console.log(chalk.red("    ✗ prompts or responses"));
  console.log(chalk.red("    ✗ file paths or code"));
  console.log(chalk.red("    ✗ error messages"));
  console.log(chalk.red("    ✗ personally identifying information"));
  console.log("");
  console.log(chalk.gray("  run `nerfdetector export` anytime to audit local data"));
  console.log(chalk.gray("  run `nerfdetector uninstall` to remove all hooks"));
  console.log("");
  console.log(chalk.green("  ✓ setup complete"));
  console.log("");
}

export async function runUninstall() {
  console.log("");

  let anyRemoved = false;
  for (const tool of TOOLS) {
    const cfg = tool.hookConfig();
    if (existsSync(cfg.configPath)) {
      const removed = removeHooks(cfg);
      if (removed) {
        console.log(chalk.green(`  ✓ removed hooks from ${tool.name}`));
        anyRemoved = true;
      }
    }
  }

  if (!anyRemoved) {
    console.log(chalk.gray("  no hooks to remove"));
  }

  console.log("");
}
