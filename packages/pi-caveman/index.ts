import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

const LEVELS = ["lite", "full", "ultra"] as const;
type CavemanLevel = (typeof LEVELS)[number];
type CavemanMode = CavemanLevel | "off";

type CavemanStateEntry = {
	mode?: CavemanMode;
};

type CavemanConfig = {
	defaultMode?: CavemanMode;
};

const LEVEL_SET = new Set<string>(LEVELS);
const STATE_ENTRY_KEY = "caveman-state";
const STATUS_KEY = "caveman";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "caveman.json");

function normalizeMode(value: string | undefined): CavemanMode | null {
	if (!value) return "full";
	const normalized = value.trim().toLowerCase();
	if (!normalized) return "full";
	if (LEVEL_SET.has(normalized)) return normalized as CavemanLevel;
	if (normalized === "off" || normalized === "normal" || normalized === "stop")
		return "off";
	return null;
}

const MODE_RULES: Record<CavemanLevel, string> = {
	lite: "No filler or hedging. Keep articles and full sentences. Professional but tight.",
	full: "Drop articles, filler, pleasantries, hedging. Fragments OK. Short synonyms. Technical terms exact.",
	ultra:
		"Maximum compression. Abbreviate common tech terms. Use arrows for causality. Strip conjunctions. One word when enough.",
};

function buildPrompt(mode: CavemanLevel): string {
	return `
IMPORTANT: Caveman mode active for this turn. Level: ${mode}.
Rules: Be terse. Keep technical accuracy. Code blocks, commits, and PR text stay normal. For security warnings or irreversible actions, be clear and unambiguous. Stop only if user says "stop caveman" or "normal mode".
Mode rules: ${MODE_RULES[mode]}
`;
}

async function loadConfig(): Promise<CavemanConfig> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as CavemanConfig;
		if (
			parsed.defaultMode === undefined ||
			parsed.defaultMode === "off" ||
			LEVEL_SET.has(parsed.defaultMode)
		) {
			return parsed;
		}
	} catch {}
	return { defaultMode: "full" };
}

function getAutocompleteItems(prefix: string): AutocompleteItem[] | null {
	const items: AutocompleteItem[] = [
		...LEVELS.map((level) => ({ value: level, label: level })),
		{ value: "off", label: "off" },
	];
	const filtered = items.filter((item) =>
		item.value.startsWith(prefix.toLowerCase()),
	);
	return filtered.length > 0 ? filtered : null;
}

export default function cavemanExtension(pi: ExtensionAPI) {
	let mode: CavemanMode = "off";

	const persistMode = (nextMode: CavemanMode) => {
		pi.appendEntry(STATE_ENTRY_KEY, {
			mode: nextMode,
		} satisfies CavemanStateEntry);
	};

	const setMode = (
		nextMode: CavemanMode,
		ctx: ExtensionContext,
		notify = true,
	) => {
		mode = nextMode;
		persistMode(nextMode);
		if (!notify) return;
		if (nextMode === "off") {
			ctx.ui.notify("Caveman mode off", "info");
			return;
		}
		ctx.ui.notify(`Caveman mode: ${nextMode}`, "info");
	};

	pi.on("session_start", async (_event, ctx) => {
		mode = "off";
		const config = await loadConfig();
		let restoredFromSession = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_KEY)
				continue;
			const data = entry.data as CavemanStateEntry | undefined;
			if (data?.mode && (data.mode === "off" || LEVEL_SET.has(data.mode))) {
				mode = data.mode;
				restoredFromSession = true;
			}
		}
		if (!restoredFromSession) {
			mode = config.defaultMode ?? "full";
			if (mode !== "off") persistMode(mode);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (mode === "off") return undefined;
		return {
			systemPrompt: event.systemPrompt + buildPrompt(mode),
		};
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" } as const;
		const text = event.text.trim().toLowerCase();
		if (text === "stop caveman" || text === "normal mode") {
			setMode("off", ctx);
			return { action: "handled" } as const;
		}
		return { action: "continue" } as const;
	});

	pi.registerCommand("caveman", {
		description:
			"Enable caveman mode: /caveman [lite|full|ultra|off]",
		getArgumentCompletions: (prefix) => getAutocompleteItems(prefix),
		handler: async (args, ctx) => {
			const nextMode = normalizeMode(args);
			if (!nextMode) {
				ctx.ui.notify(`Usage: /caveman [${LEVELS.join("|")}|off]`, "warning");
				return;
			}
			setMode(nextMode, ctx);
		},
	});
}
