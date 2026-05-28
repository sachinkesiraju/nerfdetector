// Lightweight test runner — no jest/vitest dep. Run via:
//   npx tsx src/analysis/score.test.ts
import { scoreSession, safeToolName, FINGERPRINT_SCHEMA_VERSION } from "./score.js";
import type { EventRow } from "../store/db.js";

let passed = 0;
let failed = 0;

function eq(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`); }
}

function ev(o: Partial<EventRow> & { ts: number }): EventRow {
  return {
    id: 0, ts: o.ts, tool: "claude-code", model: "claude-opus-4-7",
    event_type: o.event_type ?? "tool_use",
    duration_ms: o.duration_ms ?? null,
    status: o.status ?? null,
    tool_ok: o.tool_ok ?? null,
    tool_name: o.tool_name ?? null,
    response_size: o.response_size ?? null,
    session_id: o.session_id ?? "s1",
    source: o.source ?? "hook",
    source_offset: o.source_offset ?? null,
    fingerprint: o.fingerprint ?? null,
    input_tokens: o.input_tokens ?? null,
    output_tokens: o.output_tokens ?? null,
    cache_read_tokens: o.cache_read_tokens ?? null,
    tool_input_hash: o.tool_input_hash ?? null,
  };
}

console.log("safeToolName");
eq("builtin passes through", safeToolName("Bash"), "Bash");
eq("null in null out", safeToolName(null), null);
eq("codex tool passes", safeToolName("apply_patch"), "apply_patch");
const hashed = safeToolName("acme_internal_deploy");
eq("custom is hashed", hashed?.startsWith("custom_") && hashed.length === 15, true);
eq("custom is stable", safeToolName("acme_internal_deploy"), hashed);

console.log("\nscoreSession — empty");
const empty = scoreSession({ events: [], clientVersion: "0.2.0" });
eq("schema version", empty.schemaVersion, FINGERPRINT_SCHEMA_VERSION);
eq("zero duration", empty.sessionDurationS, 0);
eq("zero calls", empty.toolCallCount, 0);
eq("zero loops", empty.loops, 0);
eq("zero resteers", empty.resteers, 0);
eq("null top tool", empty.topFailingTool, null);

console.log("\nscoreSession — happy session");
const happy = scoreSession({
  events: [
    ev({ ts: 1_000_000, event_type: "prompt" }),
    ev({ ts: 1_001_000, tool_name: "Read", tool_ok: 1, duration_ms: 500 }),
    ev({ ts: 1_002_000, tool_name: "Edit", tool_ok: 1, duration_ms: 1500 }),
    ev({ ts: 1_003_000, tool_name: "Bash", tool_ok: 1, duration_ms: 2000 }),
  ],
  clientVersion: "0.2.0",
});
eq("3 tool calls", happy.toolCallCount, 3);
eq("0 failures", happy.toolFailRate, 0);
eq("0 loops", happy.loops, 0);
eq("0 retries", happy.retryRate, 0);
eq("no top fail", happy.topFailingTool, null);

console.log("\nscoreSession — loop detection");
const looped = scoreSession({
  events: [
    ev({ ts: 1_000_000, tool_name: "Edit", tool_ok: 0, duration_ms: 1000 }),
    ev({ ts: 1_001_000, tool_name: "Edit", tool_ok: 0, duration_ms: 1000 }),
    ev({ ts: 1_002_000, tool_name: "Edit", tool_ok: 0, duration_ms: 1000 }),  // 3rd → loop + retry
    ev({ ts: 1_003_000, tool_name: "Edit", tool_ok: 0, duration_ms: 1000 }),  // 4th → another retry
    ev({ ts: 1_004_000, tool_name: "Read", tool_ok: 1, duration_ms: 500 }),
  ],
  clientVersion: "0.2.0",
});
eq("loop count", looped.loops, 1);
eq("retry count rate", looped.retryRate, round3(2 / 5));
eq("fail rate", looped.toolFailRate, round3(4 / 5));
eq("top failing is Edit", looped.topFailingTool, "Edit");

console.log("\nscoreSession — two distinct loops");
const twoLoops = scoreSession({
  events: [
    ev({ ts: 1_000_000, tool_name: "Edit" }),
    ev({ ts: 1_001_000, tool_name: "Edit" }),
    ev({ ts: 1_002_000, tool_name: "Edit" }),   // loop 1
    ev({ ts: 1_003_000, tool_name: "Read" }),   // break
    ev({ ts: 1_004_000, tool_name: "Grep" }),
    ev({ ts: 1_005_000, tool_name: "Grep" }),
    ev({ ts: 1_006_000, tool_name: "Grep" }),   // loop 2
  ],
  clientVersion: "0.2.0",
});
eq("two loops", twoLoops.loops, 2);

console.log("\nscoreSession — resteer detection");
const resteer = scoreSession({
  events: [
    ev({ ts: 1_000_000, event_type: "prompt" }),
    ev({ ts: 1_001_000, tool_name: "Edit", tool_ok: 0 }),
    ev({ ts: 1_002_000, tool_name: "Edit", tool_ok: 0 }),
    ev({ ts: 1_010_000, event_type: "prompt" }),  // resteer — 2 failures in 60s before
    ev({ ts: 1_011_000, tool_name: "Read", tool_ok: 1 }),
  ],
  clientVersion: "0.2.0",
});
eq("one resteer", resteer.resteers, 1);

console.log("\nscoreSession — baseline deviation");
const dev = scoreSession({
  events: [
    ev({ ts: 1_000_000, tool_name: "Edit", tool_ok: 0, duration_ms: 5000 }),
    ev({ ts: 1_001_000, tool_name: "Read", tool_ok: 1, duration_ms: 3000 }),
  ],
  baselines: { successRate: 0.95, retryRate: 0.05, latencyS: 1.0 },
  clientVersion: "0.2.0",
});
eq("successRate deviation", dev.deviationFromBaseline.successRate, round3(0.5 - 0.95));
eq("retryRate deviation", dev.deviationFromBaseline.retryRate, round3(0 - 0.05));
eq("latency deviation", dev.deviationFromBaseline.latency, round3(4.0 - 1.0));

console.log("\nscoreSession — custom tool name hashed");
const custom = scoreSession({
  events: [
    ev({ ts: 1_000_000, tool_name: "mcp__acme__deploy", tool_ok: 0 }),
    ev({ ts: 1_001_000, tool_name: "mcp__acme__deploy", tool_ok: 0 }),
  ],
  clientVersion: "0.2.0",
});
const isHashed = custom.topFailingTool?.startsWith("custom_") ?? false;
eq("top failing tool hashed", isHashed, true);

console.log("\nscoreSession — wasted calls (duplicates)");
const wasted = scoreSession({
  events: [
    ev({ ts: 1_000_000, tool_name: "Read", tool_input_hash: "abc123", tool_ok: 1 }),
    ev({ ts: 1_001_000, tool_name: "Read", tool_input_hash: "abc123", tool_ok: 1 }),  // waste #1
    ev({ ts: 1_002_000, tool_name: "Read", tool_input_hash: "abc123", tool_ok: 1 }),  // waste #2
    ev({ ts: 1_003_000, tool_name: "Read", tool_input_hash: "def456", tool_ok: 1 }),  // distinct, not waste
    ev({ ts: 1_004_000, tool_name: "Grep", tool_input_hash: "abc123", tool_ok: 1 }),  // same hash, different tool, not waste
  ],
  clientVersion: "0.2.0",
});
eq("wastedCalls = 2", wasted.wastedCalls, 2);

console.log("\nscoreSession — wastedCalls ignores events with no hash");
const nohash = scoreSession({
  events: [
    ev({ ts: 1_000_000, tool_name: "Read", tool_ok: 1 }),
    ev({ ts: 1_001_000, tool_name: "Read", tool_ok: 1 }),
  ],
  clientVersion: "0.2.0",
});
eq("no hash → no waste", nohash.wastedCalls, 0);

console.log("\nscoreSession — token rollup");
const tokens = scoreSession({
  events: [
    ev({ ts: 1_000_000, event_type: "turn", input_tokens: 100, output_tokens: 200, cache_read_tokens: 50 }),
    ev({ ts: 1_001_000, event_type: "turn", input_tokens: 200, output_tokens: 400, cache_read_tokens: 150 }),
    ev({ ts: 1_002_000, tool_name: "Bash", tool_ok: 1 }),
  ],
  clientVersion: "0.2.0",
});
eq("input tokens summed", tokens.tokens.input, 300);
eq("output tokens summed", tokens.tokens.output, 600);
eq("cache read summed", tokens.tokens.cacheRead, 200);
eq("cache hit rate", tokens.tokens.cacheHitRate, round3(200 / 500));

console.log("\nscoreSession — schema version is 2");
eq("schemaVersion bumped", tokens.schemaVersion, 2);

console.log("");
console.log(`${passed} passed · ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

function round3(n: number): number { return Math.round(n * 1000) / 1000; }
