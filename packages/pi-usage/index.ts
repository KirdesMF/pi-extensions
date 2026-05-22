import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type UsageTotals = {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	costTotal: number;
};

type UsageScope = "all" | "branch" | "default";

type UsageOptions = {
	scope: UsageScope;
	showLast: boolean;
	showModels: boolean;
};

const COMMAND_ARGS = [
	"all",
	"branch",
	"last",
	"models",
	"summary",
	"help",
] as const;
const COMMAND_ARG_SET = new Set<string>(COMMAND_ARGS);
const USAGE_HELP = `Usage: /usage [all|branch] [last] [models|summary]

Default shows active branch, whole session tree, last response, context usage, and model breakdown.

Examples:
  /usage
  /usage branch
  /usage all summary
  /usage last`;

function emptyTotals(): UsageTotals {
	return {
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		costTotal: 0,
	};
}

function addUsage(totals: UsageTotals, usage: Usage): UsageTotals {
	return {
		requests: totals.requests + 1,
		input: totals.input + usage.input,
		output: totals.output + usage.output,
		cacheRead: totals.cacheRead + usage.cacheRead,
		cacheWrite: totals.cacheWrite + usage.cacheWrite,
		total:
			totals.total +
			usage.input +
			usage.output +
			usage.cacheRead +
			usage.cacheWrite,
		costInput: totals.costInput + usage.cost.input,
		costOutput: totals.costOutput + usage.cost.output,
		costCacheRead: totals.costCacheRead + usage.cost.cacheRead,
		costCacheWrite: totals.costCacheWrite + usage.cost.cacheWrite,
		costTotal: totals.costTotal + usage.cost.total,
	};
}

function getAssistantMessages(
	entries: ReadonlyArray<SessionEntry>,
): Array<AssistantMessage> {
	return entries.flatMap((entry) => {
		if (entry.type !== "message") return [];
		if (entry.message.role !== "assistant") return [];
		return [entry.message as AssistantMessage];
	});
}

function summarizeUsage(
	messages: ReadonlyArray<AssistantMessage>,
): UsageTotals {
	return messages.reduce(
		(totals, message) => addUsage(totals, message.usage),
		emptyTotals(),
	);
}

function summarizeByModel(
	messages: ReadonlyArray<AssistantMessage>,
): Map<string, UsageTotals> {
	return messages.reduce((summaries, message) => {
		const key = `${message.provider}/${message.model}`;
		const current = summaries.get(key) ?? emptyTotals();
		summaries.set(key, addUsage(current, message.usage));
		return summaries;
	}, new Map<string, UsageTotals>());
}

function formatTokens(value: number): string {
	return value.toLocaleString();
}

function formatCompactTokens(value: number): string {
	if (value < 1000) return value.toLocaleString();
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(2)}m`;
}

function formatCost(value: number): string {
	return `$${value.toFixed(4)}`;
}

function formatPercent(numerator: number, denominator: number): string {
	if (denominator <= 0) return "0.0%";
	return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatTotals(title: string, totals: UsageTotals): Array<string> {
	const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
	return [
		title,
		`  Requests: ${totals.requests.toLocaleString()}`,
		`  Input: ${formatTokens(totals.input)}`,
		`  Output: ${formatTokens(totals.output)}`,
		`  Cache read: ${formatTokens(totals.cacheRead)}`,
		`  Cache write: ${formatTokens(totals.cacheWrite)}`,
		`  Total: ${formatTokens(totals.total)}`,
		`  Cache hit: ${formatPercent(totals.cacheRead, promptTokens)}`,
		`  Cost: ${formatCost(totals.costTotal)} (in ${formatCost(totals.costInput)}, out ${formatCost(totals.costOutput)}, read ${formatCost(totals.costCacheRead)}, write ${formatCost(totals.costCacheWrite)})`,
	];
}

function formatLastResponse(
	messages: ReadonlyArray<AssistantMessage>,
): Array<string> {
	const last = messages.at(-1);
	if (!last) return ["Last response", "  None yet"];
	return [
		"Last response",
		`  Model: ${last.provider}/${last.model}`,
		...formatTotals("  Usage", addUsage(emptyTotals(), last.usage)).map(
			(line) => (line === "  Usage" ? line : `  ${line.trimStart()}`),
		),
	];
}

function formatContext(ctx: ExtensionCommandContext): Array<string> {
	const usage = ctx.getContextUsage();
	if (!usage) return ["Current context", "  Unknown"];
	const tokens = usage.tokens === null ? "unknown" : formatTokens(usage.tokens);
	const percent =
		usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
	return [
		"Current context",
		`  Tokens: ${tokens}`,
		`  Window: ${formatTokens(usage.contextWindow)}`,
		`  Used: ${percent}`,
	];
}

function formatModelBreakdown(
	messages: ReadonlyArray<AssistantMessage>,
): Array<string> {
	const summaries = [...summarizeByModel(messages).entries()].sort(
		([, left], [, right]) => right.total - left.total,
	);
	if (summaries.length === 0) return ["By model", "  None yet"];
	return [
		"By model",
		...summaries.map(([model, totals]) => {
			const parts = [
				`${model}:`,
				`${totals.requests} req`,
				`↑${formatCompactTokens(totals.input)}`,
				`↓${formatCompactTokens(totals.output)}`,
				`R${formatCompactTokens(totals.cacheRead)}`,
				`W${formatCompactTokens(totals.cacheWrite)}`,
				formatCost(totals.costTotal),
			];
			return `  ${parts.join(" ")}`;
		}),
	];
}

function getScope(tokens: ReadonlyArray<string>): UsageScope | null {
	const hasAll = tokens.includes("all");
	const hasBranch = tokens.includes("branch");
	if (hasAll && hasBranch) return null;
	if (hasAll) return "all";
	if (hasBranch) return "branch";
	return "default";
}

function parseOptions(args: string): UsageOptions | "help" | null {
	const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return { scope: "default", showLast: true, showModels: true };
	}
	if (
		tokens.includes("help") ||
		tokens.includes("--help") ||
		tokens.includes("-h")
	) {
		return "help";
	}
	const invalid = tokens.find((token) => !COMMAND_ARG_SET.has(token));
	if (invalid) return null;
	const scope = getScope(tokens);
	if (!scope) return null;
	return {
		scope,
		showLast: tokens.includes("last") || scope === "default",
		showModels:
			!tokens.includes("summary") &&
			(tokens.includes("models") || scope === "default"),
	};
}

function getAutocompleteItems(prefix: string): Array<AutocompleteItem> | null {
	const normalized = prefix.toLowerCase();
	const items = COMMAND_ARGS.map((arg) => ({ value: arg, label: arg }));
	const filtered = items.filter((item) => item.value.startsWith(normalized));
	return filtered.length > 0 ? filtered : null;
}

function buildReport(
	options: UsageOptions,
	ctx: ExtensionCommandContext,
): string {
	const branchEntries = ctx.sessionManager.getBranch();
	const allEntries = ctx.sessionManager.getEntries();
	const branchMessages = getAssistantMessages(branchEntries);
	const allMessages = getAssistantMessages(allEntries);
	const targetMessages = options.scope === "all" ? allMessages : branchMessages;
	const reportLines = ["Usage", ""];

	if (options.scope !== "all") {
		reportLines.push(
			...formatTotals("Active branch", summarizeUsage(branchMessages)),
			"",
		);
	}
	if (options.scope !== "branch") {
		reportLines.push(
			...formatTotals("Whole session tree", summarizeUsage(allMessages)),
			"",
		);
	}
	if (options.showLast) {
		reportLines.push(...formatLastResponse(targetMessages), "");
	}
	reportLines.push(...formatContext(ctx));
	if (options.showModels) {
		reportLines.push("", ...formatModelBreakdown(targetMessages));
	}
	return reportLines.join("\n");
}

export default function usageExtension(pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show detailed token, cache, context, and cost usage",
		getArgumentCompletions: (prefix) => getAutocompleteItems(prefix),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const options = parseOptions(args);
			if (options === "help") {
				ctx.ui.notify(USAGE_HELP, "info");
				return;
			}
			if (!options) {
				ctx.ui.notify(USAGE_HELP, "warning");
				return;
			}
			ctx.ui.notify(buildReport(options, ctx), "info");
		},
	});
}
