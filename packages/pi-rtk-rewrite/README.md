# pi-rtk-rewrite

Pi extension that rewrites `bash` tool calls through [RTK](https://github.com/rtk-ai/rtk) before execution.

## What it does

When pi is about to run a `bash` tool command like:

```bash
git status
```

extension asks RTK:

```bash
rtk rewrite "git status"
```

If RTK returns rewrite like:

```bash
rtk git status
```

extension mutates tool input so pi executes RTK version instead.

This gives RTK token-optimized output for shell commands without changing pi built-in tools.

## Scope

Affects only pi `bash` tool calls.

Does **not** affect:
- `read`
- `edit`
- `write`
- other non-bash tools

## Requirements

RTK must be installed and available in `PATH`:

```bash
brew install rtk
```

Verify:

```bash
rtk rewrite "git status"
```

## Install in pi

Add package path to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "~/code/pi-extensions/packages/pi-rtk-rewrite"
  ]
}
```

Then reload pi:

```text
/reload
```

## Commands

Extension registers:

- `/rtk-rewrite status`
- `/rtk-rewrite on`
- `/rtk-rewrite off`
- `/rtk-rewrite refresh`
- `/rtk-rewrite test <cmd>`
- `/rtk-rewrite help`

## Config

Environment variables:

- `PI_RTK_REWRITE_ENABLED=1|0` — enable by default. Default `1`
- `PI_RTK_REWRITE_TIMEOUT_MS=2000` — timeout for `rtk rewrite`
- `PI_RTK_REWRITE_VERBOSE=1|0` — show rewrite notifications
- `PI_RTK_REWRITE_SHOW_STATUS=1|0` — show footer status

## Behavior notes

- Keeps in-memory cache of rewrites for repeated commands
- Skips commands already starting with `rtk `
- Prepends `export LC_ALL=C` to rewritten command unless `LC_ALL=` already present
- If RTK missing or fails, original bash command still runs

## Example

Input tool call:

```bash
cargo test
```

Rewritten execution:

```bash
export LC_ALL=C
rtk cargo test
```

## Files

- `index.ts` — extension entry
- `package.json` — pi package manifest
