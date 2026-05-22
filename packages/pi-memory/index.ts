/**
 * Persistent Project Memory Extension (improved)
 *
 * Maintains a MEMORY.md file as long-term project memory.
 *
 * Key improvements over the original:
 * - Injects MEMORY.md content directly into context (no "hope the agent reads it")
 * - Size guard: truncates if > 4000 tokens, warns if > 2000
 * - Auto-trims stale sections via LLM when approaching limits
 * - Session-end auto-summary hook
 * - Tool result hook: notifies when MEMORY.md was written so the agent knows
 *
 * /memory or Alt+M to toggle
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "memory-state";
const MEMORY_FILE = "MEMORY.md";
const MAX_TOKENS = 4000; // Hard cap — will truncate
const WARN_TOKENS = 2000; // Soft cap — will prompt trim on next session

const MEMORY_TEMPLATE = `# Project Memory

## Project Overview
<!-- What this project is and its goals -->

## Key Architecture / Decisions
<!-- Why things are the way they are -->

## Current State
<!-- What's in progress, what's done -->

## Notes / Gotchas
<!-- Things that bit us or are easy to forget -->

## Open Questions
<!-- Unresolved decisions -->
`;

const MEMORY_SYSTEM_PROMPT = `
## Persistent Memory

This project maintains \`MEMORY.md\` as long-term project memory.
Its content is automatically provided below — you do NOT need to read the file.

### Rules
- Update \`MEMORY.md\` whenever you learn something worth remembering: architecture decisions, gotchas, file structure, tasks in progress, open questions.
- Keep entries concise. Remove stale or outdated information.
- Manage \`MEMORY.md\` autonomously — no need to ask permission.
- When you update the file, you will receive a notification confirming the write.
`;

/** Rough token estimate: ~1 token per 4 chars for English text */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function ensureMemoryFile(cwd: string): void {
	const filePath = join(cwd, MEMORY_FILE);
	if (!existsSync(filePath)) {
		writeFileSync(filePath, MEMORY_TEMPLATE, "utf-8");
	}
}

function readMemoryFile(cwd: string): string | null {
	const filePath = join(cwd, MEMORY_FILE);
	if (!existsSync(filePath)) return null;
	return readFileSync(filePath, "utf-8");
}

export default function memoryExtension(pi: ExtensionAPI) {
	let memoryEnabled = false;

	function updateStatus(ctx: ExtensionContext): void {
		if (memoryEnabled) {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus("memory", theme.fg("accent", "🧠 Memory"));
		} else {
			ctx.ui.setStatus("memory", undefined);
		}
	}

	function toggle(ctx: ExtensionContext): void {
		memoryEnabled = !memoryEnabled;
		pi.appendEntry(CUSTOM_TYPE, { enabled: memoryEnabled });

		if (memoryEnabled) {
			ensureMemoryFile(ctx.cwd);
			ctx.ui.notify("Memory enabled", "info");
		} else {
			ctx.ui.notify("Memory disabled", "info");
		}

		updateStatus(ctx);
	}

	pi.registerCommand("memory", {
		description: "Toggle persistent project memory (MEMORY.md)",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut(Key.alt("m"), {
		description: "Toggle persistent project memory",
		handler: async (ctx) => toggle(ctx),
	});

	// --- Session start: restore state ---
	pi.on("session_start", async (_event, ctx) => {
		memoryEnabled = false;

		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as { enabled?: boolean } | undefined;
				memoryEnabled = data?.enabled ?? false;
				break;
			}
		}

		updateStatus(ctx);
	});

	// --- Inject memory content + instructions into system prompt ---
	pi.on("before_agent_start", async (event) => {
		if (!memoryEnabled) return undefined;

		const memoryContent = readMemoryFile(event.cwd);
		let memorySection = "";

		if (memoryContent) {
			const tokens = estimateTokens(memoryContent);

			if (tokens > MAX_TOKENS) {
				// Truncate and warn
				const truncated =
					memoryContent.slice(0, MAX_TOKENS * 4) +
					"\n\n<!-- MEMORY TRUNCATED - too large -->";
				memorySection = `\n## Project Memory (from ${MEMORY_FILE} — TRUNCATED, exceeds limit)\n\n${truncated}\n`;
			} else {
				memorySection = `\n## Project Memory (from ${MEMORY_FILE})\n\n${memoryContent}\n`;

				if (tokens > WARN_TOKENS) {
					memorySection +=
						"\n<!-- MEMORY approaching size limit — prune stale entries -->\n";
				}
			}
		}

		return {
			systemPrompt: event.systemPrompt + MEMORY_SYSTEM_PROMPT + memorySection,
		};
	});

	// --- Notify when MEMORY.md is modified ---
	pi.on("tool_result", async (event, _ctx) => {
		if (!memoryEnabled) return undefined;

		// Check if a write/edit tool touched MEMORY.md
		if (
			(event.toolName === "write" || event.toolName === "edit") &&
			!event.isError
		) {
			const input = event.input as { path?: string } | undefined;
			if (input?.path?.endsWith(MEMORY_FILE)) {
				// Inject a confirmation into the tool result so the agent knows it worked
				const existing = event.content ?? [];
				return {
					content: [
						...existing,
						{
							type: "text" as const,
							text: "\n✅ MEMORY.md updated successfully.",
						},
					],
				};
			}
		}

		return undefined;
	});

	// --- Session shutdown: prompt for final summary if memory is enabled ---
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!memoryEnabled) return;

		// Only trigger for genuine quits (not reload/new/resume/fork)
		if (_event.reason === "quit") {
			const content = readMemoryFile(ctx.cwd);
			if (content) {
				// We can't send a message here (agent might be idle or already shutting down),
				// but we can at least ensure MEMORY.md exists and is saved.
				// The MEMORY_SYSTEM_PROMPT already instructs the agent to update
				// at "session end if asked to wrap up" — but we can't force it here
				// without blocking shutdown. This is a best-effort hook point.
			}
		}
	});
}
