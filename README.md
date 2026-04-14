# nerfdetector

[![npm](https://img.shields.io/npm/v/nerfdetector)](https://www.npmjs.com/package/nerfdetector)

Crowdsourced real-time model performance. Is your model nerfed?

When Claude, GPT, Gemini, or Grok is having a bad day, you shouldn't have to wonder if it's just you. nerfdetector watches your AI coding sessions and lets you report how it's going — one keypress at the end of every session.

## Install

```
npm i -g nerfdetector
nerfdetector init
```

`init` detects your AI coding tools (Claude Code, Codex CLI, Gemini CLI), installs lightweight hooks, and prints exactly what data it will and won't collect.

## How it works

1. You use Claude Code / Codex / Gemini normally
2. When you exit, one line appears:

```
nerfdetector · claude-opus-4-6 (100%) · 23 actions · 4 failed
how was your session? [f] fine  [n] nerfed  [s] skip
```

3. Press one key. Done.

- **f** — sends your vote as "fine"
- **n** — sends your vote as "nerfed"
- **s** or wait 10 seconds — nothing is sent

Your vote is weighted by which models you actually used — if you used Opus and Sonnet in the same session, the vote counts proportionally against each. No picking from a dropdown.

## Commands

```
nerfdetector              detect tools + install hooks (same as init)
nerfdetector init         detect tools + install hooks
nerfdetector help         show help
nerfdetector status       your session + global model status
nerfdetector report       vote on your session (--fine or --nerfed)
nerfdetector export       dump local events as JSON (privacy audit)
nerfdetector uninstall    remove all hooks
```

## What gets collected

**Sent when you vote:**
- Model names (e.g. `claude-opus-4-6`)
- Call counts
- Error counts and status codes
- Tool success/failure counts

**Never sent:**
- Prompts or responses
- File paths or code
- Error messages
- Personally identifying information

All events are stored locally in `~/.nerfdetector/events.db`. Run `nerfdetector export` anytime to verify.

## Supported tools

| Tool | Status |
|---|---|
| Claude Code | Full support |
| Codex CLI | Full support |
| Gemini CLI | Full support |

## Uninstall

```
nerfdetector uninstall
npm uninstall -g nerfdetector
rm -rf ~/.nerfdetector   # remove local data
```

## License

MIT
