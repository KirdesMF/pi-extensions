import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tokens-per-second";
const CHARS_PER_TOKEN = 4;
const MIN_SAMPLE_SECONDS = 0.1;
const MAX_TTFT_SAMPLE_SECONDS = 120;
const MAX_TTFT_SAMPLES = 100;

type TpsMode = "on" | "off";

type AssistantContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string };

type Usage = {
	input?: number;
	output?: number;
};

type AssistantMessageLike = {
	role: string;
	content?: unknown;
	usage?: Usage;
};

function isAssistantMessage(message: unknown): message is AssistantMessageLike {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		(message as { role?: unknown }).role === "assistant"
	);
}

function getTextLength(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.reduce((total: number, block: unknown) => {
		if (!isAssistantContentBlock(block)) return total;
		if (block.type === "text") return total + block.text.length;
		return total + block.thinking.length;
	}, 0);
}

function isAssistantContentBlock(
	block: unknown,
): block is AssistantContentBlock {
	if (typeof block !== "object" || block === null) return false;
	const candidate = block as {
		type?: unknown;
		text?: unknown;
		thinking?: unknown;
	};
	if (candidate.type === "text") return typeof candidate.text === "string";
	if (candidate.type === "thinking")
		return typeof candidate.thinking === "string";
	return false;
}

function formatTps(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "-- t/s";
	return `${Math.round(value)} t/s`;
}

function formatSeconds(value: number): string {
	return `${value.toFixed(1)}s`;
}

function average(values: ReadonlyArray<number>): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderStatus(
	ctx: Pick<ExtensionContext, "ui">,
	state: {
		label: "waiting" | "live" | "done" | "avg" | "idle";
		tps?: number;
		ttft?: number;
		elapsed?: number;
	},
): string {
	const theme = ctx.ui.theme;
	const labelByState: Record<typeof state.label, string> = {
		waiting: theme.fg("dim", "tps waiting"),
		live: theme.fg("accent", formatTps(state.tps ?? 0)),
		done: theme.fg("success", formatTps(state.tps ?? 0)),
		avg: `${theme.fg("dim", "avg ")}${theme.fg("accent", formatTps(state.tps ?? 0))}`,
		idle: theme.fg("dim", "tps idle"),
	};
	const ttft =
		state.ttft && state.ttft > 0 ? ` · ${formatSeconds(state.ttft)}` : "";
	const elapsed =
		state.elapsed && state.elapsed > 0
			? ` (${formatSeconds(state.elapsed)})`
			: "";
	return `${labelByState[state.label]}${theme.fg("dim", ttft + elapsed)}`;
}

export default function tokensPerSecondExtension(pi: ExtensionAPI) {
	let mode: TpsMode = "on";
	let turnStart = 0;
	let streamStart = 0;
	let streaming = false;
	let lastTtft = 0;
	let lastTps = 0;
	let totalOutputTokens = 0;
	let totalStreamSeconds = 0;
	const ttftSamples: Array<number> = [];

	function setStatus(ctx: ExtensionContext, text: string | undefined): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function showIdle(ctx: ExtensionContext): void {
		if (mode === "off") {
			setStatus(ctx, undefined);
			return;
		}
		if (totalOutputTokens > 0 && totalStreamSeconds > 0) {
			setStatus(
				ctx,
				renderStatus(ctx, {
					label: "avg",
					tps: totalOutputTokens / totalStreamSeconds,
					ttft: average(ttftSamples),
				}),
			);
			return;
		}
		setStatus(ctx, renderStatus(ctx, { label: "idle" }));
	}

	function rememberTtft(): void {
		if (lastTtft <= 0 || lastTtft >= MAX_TTFT_SAMPLE_SECONDS) return;
		ttftSamples.push(lastTtft);
		if (ttftSamples.length <= MAX_TTFT_SAMPLES) return;
		ttftSamples.shift();
	}

	pi.registerCommand("tps", {
		description: "Toggle status-bar tokens per second: /tps [on|off|reset]",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "reset") {
				lastTps = 0;
				totalOutputTokens = 0;
				totalStreamSeconds = 0;
				ttftSamples.length = 0;
				showIdle(ctx);
				ctx.ui.notify("TPS stats reset", "info");
				return;
			}

			if (command === "on") {
				mode = "on";
				showIdle(ctx);
				ctx.ui.notify("TPS status on", "info");
				return;
			}

			if (command === "off") {
				mode = "off";
				setStatus(ctx, undefined);
				ctx.ui.notify("TPS status off", "info");
				return;
			}

			mode = mode === "on" ? "off" : "on";
			if (mode === "on") {
				showIdle(ctx);
			} else {
				setStatus(ctx, undefined);
			}
			ctx.ui.notify(`TPS status ${mode}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		showIdle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setStatus(ctx, undefined);
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnStart = performance.now();
		streamStart = 0;
		streaming = false;
		lastTtft = 0;
		if (mode === "off") return;
		setStatus(ctx, renderStatus(ctx, { label: "waiting" }));
	});

	pi.on("message_update", async (event, ctx) => {
		if (mode === "off") return;
		if (!isAssistantMessage(event.message)) return;

		const now = performance.now();
		if (!streaming) {
			streaming = true;
			streamStart = now;
			lastTtft = turnStart > 0 ? (streamStart - turnStart) / 1000 : 0;
		}

		const elapsed = (now - streamStart) / 1000;
		if (elapsed < MIN_SAMPLE_SECONDS) return;

		const estimatedTokens =
			getTextLength(event.message.content) / CHARS_PER_TOKEN;
		lastTps = estimatedTokens / elapsed;
		setStatus(
			ctx,
			renderStatus(ctx, {
				label: "live",
				tps: lastTps,
				ttft: lastTtft,
			}),
		);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;

		const elapsed =
			streamStart > 0 ? (performance.now() - streamStart) / 1000 : 0;
		const outputTokens = event.message.usage?.output ?? 0;
		if (elapsed > MIN_SAMPLE_SECONDS && outputTokens > 0) {
			lastTps = outputTokens / elapsed;
			totalOutputTokens += outputTokens;
			totalStreamSeconds += elapsed;
		}

		streaming = false;
		rememberTtft();

		if (mode === "off") return;
		if (lastTps > 0) {
			setStatus(
				ctx,
				renderStatus(ctx, {
					label: "done",
					tps: lastTps,
					ttft: lastTtft,
					elapsed,
				}),
			);
			return;
		}
		showIdle(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (streaming) return;
		showIdle(ctx);
	});
}
