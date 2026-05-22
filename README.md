# pi-extensions

Personal pi extensions monorepo. Every extension lives in `packages/<name>/` with `package.json` + `index.ts`.

## Packages

### Core

| Package | Description |
|---|---|
| **pi-subagents** | Delegate tasks to specialized subagents (scout/researcher/worker/reviewer) with isolated context |
| **pi-caveman** | Caveman mode — drop articles and filler from LLM output |
| **pi-memory** | Persistent project memory via `MEMORY.md`, auto-injected into system prompt |

### UI

| Package | Description |
|---|---|
| **pi-minimal-shell** | Compact shell UI replacing default header/footer with context gauges, model info, git status |
| **pi-mac-theme** | Auto-switch light/dark theme based on macOS system appearance |
| **pi-notify** | Terminal notifications when agent finishes (OSC 777 + OSC 99) |

### Tools

| Package | Description |
|---|---|
| **pi-ask** | Rich interactive `ask_user_question` tool — text input, single-select, multi-select with custom answers |
| **pi-usage** | `/usage` command for token/cache/cost stats across sessions |
| **pi-rtk-rewrite** | Rewrites bash commands through `rtk` CLI before execution |

## Setup

Add packages to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "~/code/pi-extensions/packages/pi-subagents",
    "~/code/pi-extensions/packages/pi-caveman",
    "~/code/pi-extensions/packages/pi-memory",
    "~/code/pi-extensions/packages/pi-minimal-shell",
    "~/code/pi-extensions/packages/pi-mac-theme",
    "~/code/pi-extensions/packages/pi-notify",
    "~/code/pi-extensions/packages/pi-ask",
    "~/code/pi-extensions/packages/pi-usage",
    "~/code/pi-extensions/packages/pi-rtk-rewrite"
  ]
}
```

Then `/reload` or restart pi.

## Development

```bash
bun install
bun run check   # biome lint + format check
bun run format  # biome format --write
```

## Structure

```
pi-extensions/
└── packages/
    ├── pi-ask/              # ask_user_question tool
    ├── pi-caveman/          # caveman mode
    ├── pi-mac-theme/        # macOS theme sync
    ├── pi-memory/           # project memory
    ├── pi-minimal-shell/    # custom shell UI
    ├── pi-notify/           # terminal notifications
    ├── pi-rtk-rewrite/      # RTK bash rewriting
    ├── pi-subagents/        # subagent delegation
    │   ├── agents/          # agent definitions (.md frontmatter)
    │   └── tools/           # custom tools (web-search, web-fetch, safe-bash)
    └── pi-usage/            # usage analytics
```
