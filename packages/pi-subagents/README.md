# pi-subagents

Pi extension that registers a `subagent` tool with three agents:

| Agent | Tools | Model | Purpose |
|-------|-------|-------|---------|
| **scout** | read, grep, find, ls | deepseek-v4-flash | Fast codebase recon |
| **researcher** | web_search, web_fetch | deepseek-v4-pro | Web research |
| **reviewer** | read, bash, grep, find, ls | gpt-5.2 (openai-codex) | Code review — catches bugs, edge cases, style issues |
| **worker** | read, write, edit, bash, web_search, web_fetch, subagent | gpt-5.5 (openai-codex) | Code changes (can dispatch scout/researcher/reviewer) |

`worker` is allowlisted to spawn only `scout` and `researcher` (via `subagent_agents` in its frontmatter), so the chain stops at depth 2 — a worker cannot recurse into another worker.

## Usage

One tool call = one subagent:

```json
{ "agent": "scout", "task": "Find all auth-related files in src/" }
```

To fan out, emit multiple `subagent` tool calls in the same turn — pi runs them in parallel automatically. A per-process semaphore caps simultaneous subagents at `maxConcurrency` (default 4); calls past the cap wait their turn.

Each subagent runs as an isolated `pi` process with no inherited context — all context must be in the task description.

## Config

Optional `config.json` next to `index.ts`:

```json
{ "maxConcurrency": 4 }
```

## Output

Subagents return text only — no file handoff. If the parent needs artifacts, instruct the subagent to `write` them and return the path.

Large outputs (>50KB) are head-truncated before being returned.

## UI

Two levels, toggled with `Ctrl+O`:

- **Collapsed (default):** one-line header with 60-char task preview. Result block shows agent header (status, tool count, duration), chronological tool log (one line per call, running calls marked with `▸`), latest prose "thinking" line, and a usage line (tokens in/out, cache, cost, context-window gauge).
- **Expanded:** same as collapsed, plus the full task body streaming live as the parent writes it, and the subagent's final output rendered as markdown. Nested children (when a worker spawns scout/researcher) render inline, indented under the dispatch row with their own per-row context gauge.

## Dependencies

All tools ship in this repo (`tools/`). `web_search` uses the Tavily API — set `TAVILY_API_KEY` in your environment. `web_fetch` fetches page content via native `fetch()`. No external extensions needed.

`safe-bash.ts` still exists in `tools/` if you ever want to re-enable it per-agent.

## Registering Agents from Other Extensions

Other extensions can dynamically register and unregister agents at runtime via `globalThis.__pi_subagents`:

```typescript
const subagents = (globalThis as any).__pi_subagents as
  | { registerAgent: (config: AgentConfig) => void; unregisterAgent: (name: string) => void }
  | undefined;

subagents?.registerAgent({
  name: "my-agent",
  description: "Does a specific thing",
  tools: ["web_search"],
  model: "opencode/gpt-5.5",
  thinking: "medium",
  systemPrompt: "You are an agent that does a specific thing...",
  filePath: "/path/to/my-agent.md",
});
```

## Structure

```
pi-subagents/
├── index.ts           # Extension entry point
├── agents/            # Built-in agent configs (frontmatter + system prompt)
│   ├── scout.md
│   ├── researcher.md
│   ├── reviewer.md
│   └── worker.md
├── tools/             # Extensions loaded into subagent processes
│   ├── web-search.ts  # Tavily-powered web search
│   └── web-fetch.ts   # Full page content fetching
├── config.json        # Optional: { maxConcurrency: 4 }
└── package.json
```
