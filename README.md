# nerfdetector

[npm](https://www.npmjs.com/package/nerfdetector)

nerfdetector monitors real-time model performance. Is your model nerfed?

When Claude, GPT, Gemini, Grok, or Devin is having a bad day, you shouldn't have to wonder if it's just you. nerfdetector watches your AI coding sessions and lets you report how it's going — one keypress at the end of every session.

## Install

```
npm i -g nerfdetector
nerfdetector
```

`nerfdetector` detects your AI coding tools (Claude Code, Codex CLI, Gemini CLI) and installs lightweight hooks. The install process explains exactly what data it will and will not collect.

## How it works

1. You use Claude Code / Codex / Gemini normally
2. At session start, you see how your model is doing globally:

```
nerfdetector · Claude Opus 4.6: 🔴 ▅▄▃▂▂▂▂▂ 12% · 40 reports
```

1. After meaningful work, one line appears:

```
nerfdetector · claude-opus-4-6 (100%) · 23 actions · 4 failed · 3 retries
how was your session? [f] fine  [m] mid  [n] nerfed  [s] skip
```

1. Press one key. Done.

- **f** — sends your vote as "fine"
- **m** — sends your vote as "mid" (worked but mediocre)
- **n** — sends your vote as "nerfed"
- **s** or wait 5 seconds — skips vote, sends anonymous telemetry

Your vote is weighted by which models you actually used — if you used Opus and Sonnet in the same session, the vote counts proportionally against each. 

Anytime, run `nerfdetector status` for the full board — each model's last 6 hours of crowd sentiment as a trend sparkline, sorted worst-first:

```
$ nerfdetector status

  global  ·  6-hour sentiment trend
  ────────────────────────────────────────────────────────
  🔴 Claude Opus 4.6    ▅▄▃▂▂▂▂▂▂▂▂▂  12% · 41% health · 40 reports
  🟡 Gemini 3.1 Pro     ▅▅▅▄▅▅▄▅▅▅▅▅  51% · 60% health · 22 reports
  🟢 Claude Opus 4.7    ▆▆▇▇▇▇▇▇▇▇▇▇  88% · 91% health · 25 reports
```

The sparkline is colored by tier (red/yellow/green) so a model sliding into a bad day is obvious before you even read the number.

## Commands

```
nerfdetector              detect tools + install hooks (same as init)
nerfdetector init         detect tools + install hooks (--backfill 7d default, --no-backfill to skip)
nerfdetector help         show help
nerfdetector status       your session + global model status
nerfdetector doctor       verify hooks are firing + event pipeline is healthy
nerfdetector inspect      preview the fingerprint that would be sent on vote
nerfdetector history      your personal trends (--days 7) or --session <id> to drill in
nerfdetector compare      scorecard diff between two sessions: compare <a> <b>
nerfdetector report       vote on your session (--fine, --mid, or --nerfed)
nerfdetector export       dump local events as JSON (privacy audit)
nerfdetector uninstall    remove all hooks
```

## In-session analytics (new in v0.2)

Run `nerfdetector inspect` anytime to see how the current session is going — including **token usage**, with a cache-hit gauge that shows how much context is being reprocessed vs. served from cache:

```
$ nerfdetector inspect

  current session — claude-opus-4-6 (100%)
  ─────────────────────────────────────────

  duration       47m
  tool calls     31
  failures       7 (23%)
  retries        5 (16%)
  loops          2
  resteers       1
  wasted calls   4  (duplicate tool calls)
  top fail tool  Edit

  token usage · 359.2k in → 12.9k out
    cache hit  █████████████████░░░  87%
    context     359.2k   48.2k new · 311.0k cached

  vs your 7-day norm:
    success rate   ▼ -22pts
    retry rate     ▲ +12pts
    latency        ▲ +3.4s
```

- The **cache hit** gauge turns green when most input is cache-served and red when the model is re-reading context it already had — a strong tell for a slow, expensive session.
- **context** breaks the total input into *new* tokens vs *cached* ones; **wasted calls** counts duplicate `(tool, input)` calls that burn context.
- Token usage is read from your transcript's per-turn counts — **no prompt or response content** is ever read. The same block appears in `nerfdetector history --session <id>`.

## Debugging

If hooks aren't capturing events, run `nerfdetector doctor`. It checks every link in the chain (hooks installed, events flowing, log permissions, schema version). For verbose hook tracing set `NERFDETECTOR_DEBUG=1` and look at `~/.nerfdetector/ingest.log` (mode 0600, structural-only — never logs prompt/tool content).

## What it tracks

nerfdetector tracks quality signals from your sessions and builds a personal baseline over time:

- **Tool success rate** — how many actions succeeded vs failed
- **Retry loops** — consecutive same-tool calls (model stuck in a loop)
- **Latency** — time between actions (is the model getting slower?)
- **Wasted calls** — duplicate tool calls with identical inputs (context burned re-fetching the same thing)
- **Token usage** — input/output/cache-read totals and cache hit rate, from per-turn transcript usage

To check if a session deviates significantly from your norm, you can run `nerfdetector history` to view a summary of your usage.

```
$ nerfdetector history

  claude-opus-4-6 · 154 actions

  success rate       92% →    78%  ▼ 14pts
  retry rate          6% →    19%  ▲ 3.2x
  latency           3.2s →   7.8s  ▲ 2.4x slower
  nerfed rate        12% →    45%  ▲ 3.8x more

  date    success                 actions retries  vote
  ────────────────────────────────────────────────────────────
  Apr 08  ███████████████░  94%        18       3%   🟢 fine
  Apr 09  ████████████░░░░  83%        23      13%   🟡 mid
▼ Apr 10  ██████████░░░░░░  67%        31      26%   🔴 nerfed
▼ Apr 11  █████████░░░░░░░  60%        15      33%   🔴 nerfed
  Apr 12  ██████████████░░  91%        22       5%   🟢 fine
▲ Apr 14  ███████████████░  92%        25       4%   🟢 fine

  insights · 12 voted sessions
  • 4.9× more retries when you vote nerfed vs fine
  • 73% of your evening sessions end with nerfed
  • your baseline shifted -18% since Apr 10
```

Baselines and history never leave your machine.

## What gets collected

**Sent when you vote:**

- Which models you used
- How many actions succeeded or failed
- How often the model retried or repeated identical calls
- Aggregate token counts and cache hit rate (no content)

**Never sent:**

- Prompts or responses
- File paths or code
- Error messages or tool output content
- Personally identifying information
- Your personal baselines

All events are stored locally in `~/.nerfdetector/events.db`. Run `nerfdetector export` anytime to verify, or `nerfdetector inspect` to preview exactly what a vote would send. To never attach session metrics to a vote, set `NERFDETECTOR_NO_FINGERPRINT=1`.

## Supported tools


| Tool        | Status       |
| ----------- | ------------ |
| Claude Code | Full support |
| Codex CLI   | Full support |
| Gemini CLI  | Full support |


## Uninstall

```
nerfdetector uninstall
npm uninstall -g nerfdetector
rm -rf ~/.nerfdetector   # remove local data
```

## License

MIT