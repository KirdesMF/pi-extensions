import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type UsageWindow = {
	label: string;
	usedPercent: number;
	resetsIn?: string;
};

type UsageSnapshot = {
	provider: string;
	windows: UsageWindow[];
	fetchedAt: number;
	error?: string;
};

type GitInfo = {
	branch: string | null;
	dirty: boolean;
};

type TuiHandle = {
	requestRender(): void;
};

type FooterData = {
	getExtensionStatuses(): ReadonlyMap<string, string>;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
const ANSI_REGEX = /\u001b\[[0-9;]*m/g;
const CAVEMAN_STATE_ENTRY_KEY = "caveman-state";
const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
const GIT_REFRESH_INTERVAL_MS = 20_000;
const MODEL_ICON = "󰚩";
const FOLDER_ICON = "󰉋";
const CONTEXT_ICON = "󰾆";
const THINK_ICON = "󰔟";
const CAVEMAN_ICON = "󰩪";
const BRANCH_ICON = "󰘬";
const RTK_REWRITE_STATUS_KEY = "rtk-rewrite";

function stripAnsi(text: string): string {
	return text.replace(ANSI_REGEX, "");
}

function visibleWidth(text: string): number {
	return stripAnsi(text).length;
}

function truncateToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	const plain = stripAnsi(text);
	if (plain.length <= width) return text;
	if (width <= 1) return plain.slice(0, width);
	return `${plain.slice(0, width - 1)}…`;
}

function rgb(r: number, g: number, b: number, text: string): string {
	return `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m`;
}

function dimPink(text: string): string {
	return rgb(186, 148, 176, text);
}

function colorByPercent(percent: number, text: string): string {
	if (percent >= 90) return rgb(255, 107, 107, text);
	if (percent >= 75) return rgb(255, 184, 108, text);
	return rgb(152, 195, 121, text);
}

function formatPercent(value: number): string {
	const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded}%`;
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${millions.toFixed(millions >= 10 ? 0 : 1).replace(/\.0$/, "")}M`;
	}
	if (tokens >= 1_000) {
		const thousands = tokens / 1_000;
		return `${thousands.toFixed(thousands >= 100 ? 0 : thousands >= 10 ? 1 : 1).replace(/\.0$/, "")}k`;
	}
	return `${tokens}`;
}

function formatResetTime(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.floor(diffMs / 60_000);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours < 24) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

function normalizePercent(value: number): number {
	return clampPercent(value);
}

function getWindowLabel(
	durationMs: number | undefined,
	fallback: string,
): string {
	if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0)
		return fallback;
	const hourMs = 60 * 60 * 1000;
	const dayMs = 24 * hourMs;
	const weekMs = 7 * dayMs;
	if (Math.abs(durationMs - 5 * hourMs) <= 2 * hourMs) return "5h";
	if (Math.abs(durationMs - dayMs) <= 2 * hourMs) return "day";
	if (Math.abs(durationMs - weekMs) <= 2 * hourMs) return "week";
	const hours = Math.round(durationMs / hourMs);
	if (hours >= 1 && hours < 48) return `${hours}h`;
	const days = Math.round(durationMs / dayMs);
	if (days >= 1) return `${days}d`;
	return fallback;
}

function run(command: string): string {
	return execSync(command, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 800,
	}).trim();
}

function getGitInfo(cwd: string): GitInfo {
	try {
		const branch = run(
			`cd ${JSON.stringify(cwd)} && git rev-parse --abbrev-ref HEAD 2>/dev/null`,
		);
		if (!branch || branch === "HEAD") return { branch: null, dirty: false };
		const status = run(
			`cd ${JSON.stringify(cwd)} && git status --porcelain 2>/dev/null || true`,
		);
		return { branch, dirty: status.length > 0 };
	} catch {
		return { branch: null, dirty: false };
	}
}

function loadAuthJson(): Record<string, unknown> {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	try {
		return JSON.parse(readFileSync(authPath, "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return {};
	}
}

function getCodexToken(): { token: string; accountId?: string } | null {
	const auth = loadAuthJson();
	const piCodex = auth["openai-codex"] as
		| { access?: string; accountId?: string }
		| undefined;
	if (piCodex?.access)
		return { token: piCodex.access, accountId: piCodex.accountId };

	const codexPath = join(
		process.env.CODEX_HOME || join(homedir(), ".codex"),
		"auth.json",
	);
	if (!existsSync(codexPath)) return null;
	try {
		const data = JSON.parse(readFileSync(codexPath, "utf8")) as {
			OPENAI_API_KEY?: string;
			tokens?: { access_token?: string; account_id?: string };
		};
		if (data.OPENAI_API_KEY) return { token: data.OPENAI_API_KEY };
		if (data.tokens?.access_token) {
			return {
				token: data.tokens.access_token,
				accountId: data.tokens.account_id,
			};
		}
	} catch {}
	return null;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs = 5000,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchCodexUsage(): Promise<UsageSnapshot> {
	const creds = getCodexToken();
	if (!creds)
		return {
			provider: "codex",
			windows: [],
			fetchedAt: Date.now(),
			error: "no-auth",
		};
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${creds.token}`,
			Accept: "application/json",
			"User-Agent": "pi-minimal-shell",
		};
		if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;
		const response = await fetchWithTimeout(
			"https://chatgpt.com/backend-api/wham/usage",
			{
				method: "GET",
				headers,
			},
		);
		if (!response.ok) {
			return {
				provider: "codex",
				windows: [],
				fetchedAt: Date.now(),
				error: `HTTP ${response.status}`,
			};
		}
		const data = (await response.json()) as {
			rate_limit?: {
				primary_window?: {
					used_percent?: number;
					reset_at?: number;
					limit_window_seconds?: number;
				};
				secondary_window?: {
					used_percent?: number;
					reset_at?: number;
					limit_window_seconds?: number;
				};
			};
		};
		const windows: UsageWindow[] = [];
		const primary = data.rate_limit?.primary_window;
		if (primary) {
			windows.push({
				label: getWindowLabel(
					primary.limit_window_seconds
						? primary.limit_window_seconds * 1000
						: undefined,
					"5h",
				),
				usedPercent: normalizePercent(primary.used_percent ?? 0),
				resetsIn: primary.reset_at
					? formatResetTime(new Date(primary.reset_at * 1000))
					: undefined,
			});
		}
		const secondary = data.rate_limit?.secondary_window;
		if (secondary) {
			windows.push({
				label: getWindowLabel(
					secondary.limit_window_seconds
						? secondary.limit_window_seconds * 1000
						: undefined,
					"week",
				),
				usedPercent: normalizePercent(secondary.used_percent ?? 0),
				resetsIn: secondary.reset_at
					? formatResetTime(new Date(secondary.reset_at * 1000))
					: undefined,
			});
		}
		return { provider: "codex", windows, fetchedAt: Date.now() };
	} catch (error) {
		return {
			provider: "codex",
			windows: [],
			fetchedAt: Date.now(),
			error: String(error),
		};
	}
}

async function fetchUsage(provider: string): Promise<UsageSnapshot> {
	if (provider === "openai-codex") {
		return fetchCodexUsage();
	}
	return {
		provider,
		windows: [],
		fetchedAt: Date.now(),
		error: "unsupported-provider",
	};
}

function getProviderLabel(provider: string | undefined): string {
	return provider === "openai-codex" ? "codex" : (provider ?? "model");
}

function isOpenCode(provider: string | undefined): boolean {
	return provider?.startsWith("opencode") ?? false;
}

function renderLink(url: string, text: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function getThinkingLevel(ctx: ExtensionContext | null): string {
	if (!ctx) return "off";
	try {
		const entries = ctx.sessionManager.getEntries();
		const leafId = ctx.sessionManager.getLeafId();
		const session = buildSessionContext(entries, leafId);
		return session.thinkingLevel ?? "off";
	} catch {
		return "off";
	}
}

function getContextLabel(ctx: ExtensionContext | null): {
	text: string;
	color: "dim" | "warning" | "error";
} {
	if (!ctx) return { text: "ctx:--", color: "dim" };
	try {
		const usage = ctx.getContextUsage();
		const total = ctx.model?.contextWindow;
		if (!usage || !total || usage.tokens == null)
			return { text: "ctx:--", color: "dim" };
		const percent = (usage.tokens / total) * 100;
		const text = `ctx:${formatPercent(percent)}/${formatTokenCount(total)}`;
		if (percent >= 90) return { text, color: "error" };
		if (percent >= 70) return { text, color: "warning" };
		return { text, color: "dim" };
	} catch {
		return { text: "ctx:--", color: "dim" };
	}
}

function getModelLabel(ctx: ExtensionContext | null): string {
	if (!ctx) return "no-model";
	try {
		return ctx.model?.name || ctx.model?.id || "no-model";
	} catch {
		return "no-model";
	}
}

function getFolderLabel(ctx: ExtensionContext | null): string {
	if (!ctx) return "-";
	try {
		const folder = basename(ctx.cwd);
		return folder || ctx.cwd;
	} catch {
		return "-";
	}
}

function getCavemanLabel(ctx: ExtensionContext | null): string | null {
	if (!ctx) return null;
	try {
		let current: string | null = null;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (
				entry.type !== "custom" ||
				entry.customType !== CAVEMAN_STATE_ENTRY_KEY
			)
				continue;
			const data = entry.data as { mode?: string } | undefined;
			if (data?.mode && data.mode !== "off") current = `caveman:${data.mode}`;
		}
		return current;
	} catch {
		return null;
	}
}

function renderUsageGauge(theme: Theme, window: UsageWindow): string {
	const width = 8;
	const filled = Math.round((window.usedPercent / 100) * width);
	const empty = Math.max(0, width - filled);
	const bar =
		colorByPercent(window.usedPercent, "■".repeat(filled)) +
		theme.fg("dim", "□".repeat(empty));
	const pct = colorByPercent(
		window.usedPercent,
		formatPercent(window.usedPercent),
	);
	const reset = window.resetsIn ? theme.fg("dim", `/${window.resetsIn}`) : "";
	return `${theme.fg("dim", `${window.label}:`)}${bar}${theme.fg("dim", " ")}${pct}${reset}`;
}

function buildHeaderLine(
	width: number,
	theme: Theme,
	ctx: ExtensionContext | null,
	gitInfo: GitInfo,
): string {
	const separator = theme.fg("dim", " | ");
	const context = getContextLabel(ctx);
	const folderLabel = getFolderLabel(ctx);
	const branchLabel = gitInfo.branch
		? `${gitInfo.branch}${gitInfo.dirty ? " *" : ""}`
		: null;
	const folderSegment = `${theme.fg("dim", FOLDER_ICON)} ${theme.fg("dim", folderLabel)}`;
	const modelSegment = `${dimPink(MODEL_ICON)} ${dimPink(getModelLabel(ctx))}`;
	const thinkSegment = `${theme.fg("dim", THINK_ICON)} ${theme.fg("dim", `think:${getThinkingLevel(ctx)}`)}`;
	const contextSegment = `${theme.fg("dim", CONTEXT_ICON)} ${theme.fg(context.color, context.text)}`;
	const branchSegment = branchLabel
		? `${theme.fg("dim", BRANCH_ICON)} ${theme.fg("dim", branchLabel)}`
		: null;
	const cavemanLabel = getCavemanLabel(ctx);
	const cavemanSegment = cavemanLabel
		? `${theme.fg("dim", CAVEMAN_ICON)} ${theme.fg("dim", cavemanLabel)}`
		: null;
	const rtkSegment = getGlobalRtkRewriteStatus();
	const segments = [
		theme.fg("accent", "π"),
		modelSegment,
		thinkSegment,
		folderSegment,
		branchSegment,
		contextSegment,
		cavemanSegment,
		rtkSegment,
	].filter((segment): segment is string => Boolean(segment));

	const active = [...segments];
	while (active.length > 1 && visibleWidth(active.join(separator)) > width) {
		const cavemanIndex = active.findIndex((segment) =>
			stripAnsi(segment).includes("caveman:"),
		);
		if (cavemanIndex >= 0) {
			active.splice(cavemanIndex, 1);
			continue;
		}
		const thinkIndex = active.findIndex((segment) =>
			stripAnsi(segment).includes("think:"),
		);
		if (thinkIndex >= 0) {
			active.splice(thinkIndex, 1);
			continue;
		}
		const folderIndex = active.findIndex(
			(segment) => stripAnsi(segment) === `${FOLDER_ICON} ${folderLabel}`,
		);
		if (folderIndex >= 0) {
			active.splice(folderIndex, 1);
			continue;
		}
		const branchIndex = active.findIndex((segment) => {
			const plain = stripAnsi(segment);
			return branchLabel ? plain === `${BRANCH_ICON} ${branchLabel}` : false;
		});
		if (branchIndex >= 0) {
			active.splice(branchIndex, 1);
			continue;
		}
		break;
	}

	return truncateToWidth(active.join(separator), width);
}

function getGlobalRtkRewriteStatus(): string | null {
	const global = globalThis as typeof globalThis & {
		__piRtkRewriteStatus?: string;
	};
	return global.__piRtkRewriteStatus ?? null;
}

function buildFooterLine(
	width: number,
	theme: Theme,
	provider: string | undefined,
	usage: UsageSnapshot | null,
	statuses: ReadonlyMap<string, string>,
): string {
	const separator = theme.fg("dim", " > ");
	const providerLabel = getProviderLabel(provider);
	const providerPart = isOpenCode(provider)
		? `${theme.fg("muted", `${providerLabel} => `)}${theme.fg("mdLinkUrl", renderLink("https://opencode.ai/auth", "dashboard"))}`
		: theme.fg("muted", providerLabel);
	const parts = [providerPart];
	for (const [key, status] of statuses) {
		if (key === "caveman" || key === RTK_REWRITE_STATUS_KEY) continue;
		parts.push(status);
	}
	for (const window of usage?.windows ?? []) {
		parts.push(renderUsageGauge(theme, window));
	}
	return truncateToWidth(parts.join(separator), width);
}

export default function minimalShellExtension(pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | null = null;
	let headerTui: TuiHandle | null = null;
	let footerTui: TuiHandle | null = null;
	let usage: UsageSnapshot | null = null;
	let gitInfo: GitInfo = { branch: null, dirty: false };
	let usageTimer: ReturnType<typeof setInterval> | null = null;
	let gitTimer: ReturnType<typeof setInterval> | null = null;
	let activeProvider: string | undefined;

	const requestRender = () => {
		headerTui?.requestRender();
		footerTui?.requestRender();
	};

	const clearTimers = () => {
		if (usageTimer) {
			clearInterval(usageTimer);
			usageTimer = null;
		}
		if (gitTimer) {
			clearInterval(gitTimer);
			gitTimer = null;
		}
	};

	const refreshGit = () => {
		if (!activeCtx) return;
		gitInfo = getGitInfo(activeCtx.cwd);
		requestRender();
	};

	const refreshUsage = async () => {
		if (!activeCtx) return;
		activeProvider = activeCtx.model?.provider;
		if (!activeProvider) {
			usage = null;
			requestRender();
			return;
		}
		const providerAtStart = activeProvider;
		const nextUsage = await fetchUsage(providerAtStart);
		if (activeProvider !== providerAtStart) return;
		usage = nextUsage;
		requestRender();
	};

	const startTimers = () => {
		clearTimers();
		gitTimer = setInterval(refreshGit, GIT_REFRESH_INTERVAL_MS);
		usageTimer = setInterval(() => {
			void refreshUsage();
		}, USAGE_REFRESH_INTERVAL_MS);
	};

	const applyUi = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		ctx.ui.setEditorComponent(undefined);

		ctx.ui.setWidget(
			"minimal-shell-header",
			(tui, theme) => {
				headerTui = tui;
				return {
					dispose() {
						if (headerTui === tui) headerTui = null;
					},
					invalidate() {},
					render(width: number): string[] {
						return [buildHeaderLine(width, theme, activeCtx, gitInfo)];
					},
				};
			},
			{ placement: "belowEditor" },
		);

		ctx.ui.setFooter((tui, theme, footerData: FooterData) => {
			footerTui = tui;
			return {
				dispose() {
					if (footerTui === tui) footerTui = null;
				},
				invalidate() {},
				render(width: number): string[] {
					return [
						buildFooterLine(
							width,
							theme,
							activeProvider,
							usage,
							footerData.getExtensionStatuses(),
						),
					];
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		gitInfo = getGitInfo(ctx.cwd);
		applyUi(ctx);
		await refreshUsage();
		startTimers();
		requestRender();
	});

	pi.on("session_shutdown", async () => {
		activeCtx = null;
		clearTimers();
	});

	pi.on("turn_start", async (_event, ctx) => {
		activeCtx = ctx;
		requestRender();
	});

	pi.on("turn_end", async (_event, ctx) => {
		activeCtx = ctx;
		refreshGit();
		requestRender();
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeCtx = ctx;
		requestRender();
	});

	pi.on("model_select", async (_event, ctx) => {
		activeCtx = ctx;
		await refreshUsage();
		requestRender();
	});
}
