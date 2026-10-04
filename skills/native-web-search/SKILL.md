---
name: native-web-search
description: "Trigger native web search. Use when you need quick internet research with concise summaries and full source URLs."
---

# Native Web Search

Use this skill to run a **fast model with native web search enabled** and get a concise research summary with explicit full URLs.

## Usage

Run from this skill directory:

```bash
node search.mjs "<what to search>" --purpose "<why you need this>"
```

Example:

```bash
node search.mjs "vite 7 breaking changes" --purpose "prepare migration checklist"
```

Optional flags:

- `--provider openai|anthropic`
- `--model <model-id>`
- `--timeout <ms>`
- `--json`

## Output expectations

The script instructs the model to:
- search the internet for the requested topic
- provide a concise summary for the given purpose
- include full canonical URLs (`https://...`) for each key finding
- highlight disagreements between sources

## Troubleshooting

Requires Pi 0.99+; no extra npm install is needed.

If runtime loading fails, set `PI_CODING_AGENT_MODULE_PATH` to the installed
`@earendil-works/pi-coding-agent/dist/index.js`.
