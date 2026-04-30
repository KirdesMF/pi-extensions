import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type IndicatorMode = "k2000" | "none" | "default";

type WorkingIndicatorOptions = {
	frames: string[];
	intervalMs?: number;
};

type WorkingIndicatorUI = ExtensionContext["ui"] & {
	setWorkingIndicator: (options?: WorkingIndicatorOptions) => void;
};

const STATUS_KEY = "pi-working-indicator";
const BAR_WIDTH = 10;
const BAR_CHAR = "■";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

type Rgb = readonly [number, number, number];
type Palette = {
	head: Rgb;
	tail1: Rgb;
	tail2: Rgb;
	tail3: Rgb;
};

const DARK_PALETTE: Palette = {
	head: [196, 167, 255],
	tail1: [183, 148, 245],
	tail2: [166, 129, 228],
	tail3: [148, 112, 207],
};

const LIGHT_PALETTE: Palette = {
	head: [120, 182, 255],
	tail1: [102, 170, 245],
	tail2: [84, 156, 230],
	tail3: [68, 142, 212],
};

function rgb(text: string, r: number, g: number, b: number): string {
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function getConfiguredTheme(): string | null {
	try {
		const raw = readFileSync(SETTINGS_PATH, "utf8");
		const parsed = JSON.parse(raw) as { theme?: unknown };
		if (typeof parsed.theme === "string") return parsed.theme;
	} catch {}
	return null;
}

function isLightTheme(themeName: string | null): boolean {
	if (!themeName) return false;
	return themeName.toLowerCase().includes("light");
}

function buildHeadPath(width: number, trailLength: number): number[] {
	const min = -(trailLength - 1);
	const max = width + trailLength - 2;
	const path: number[] = [];

	for (let p = min; p <= max; p++) path.push(p);
	for (let p = max - 1; p >= min + 1; p--) path.push(p);

	return path;
}

function buildK2000Frames(width: number, palette: Palette): string[] {
	const trail: ReadonlyArray<Rgb> = [
		palette.head,
		palette.tail1,
		palette.tail2,
		palette.tail3,
	];
	const path = buildHeadPath(width, trail.length);

	return path.map((head, frameIndex) => {
		const cells = new Array<string>(width).fill(" ");
		const prev = path[(frameIndex - 1 + path.length) % path.length];
		const next = path[(frameIndex + 1) % path.length];
		const dir =
			next !== head ? Math.sign(next - head) : Math.sign(head - prev) || 1;

		for (let step = 0; step < trail.length; step++) {
			const pos = head - dir * step;
			if (pos < 0 || pos >= width) continue;
			cells[pos] = rgb(BAR_CHAR, ...trail[step]);
		}

		return cells.join("");
	});
}

function applyMode(mode: IndicatorMode, ctx: ExtensionContext): void {
	const ui = ctx.ui as WorkingIndicatorUI;

	if (mode === "default") {
		ui.setWorkingIndicator();
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("dim", "Indicator: pi default"),
		);
		return;
	}

	if (mode === "none") {
		ui.setWorkingIndicator({ frames: [] });
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "Indicator: hidden"));
		return;
	}

	const themeName = getConfiguredTheme();
	const isLight = isLightTheme(themeName);
	const palette = isLight ? LIGHT_PALETTE : DARK_PALETTE;

	ui.setWorkingIndicator({
		frames: buildK2000Frames(BAR_WIDTH, palette),
		intervalMs: 70,
	});
	ctx.ui.setStatus(
		STATUS_KEY,
		ctx.ui.theme.fg("dim", `Indicator: K2000 (${isLight ? "light" : "dark"})`),
	);
}

function parseMode(value: string): IndicatorMode | null {
	if (value === "k2000") return "k2000";
	if (value === "none" || value === "off") return "none";
	if (value === "default" || value === "reset") return "default";
	return null;
}

export default function workingIndicatorExtension(pi: ExtensionAPI) {
	let mode: IndicatorMode = "k2000";

	pi.on("session_start", async (_event, ctx) => {
		applyMode(mode, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("working-indicator", {
		description: "Set working indicator: k2000, none, or reset.",
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();
			if (!raw) {
				applyMode(mode, ctx);
				ctx.ui.notify(`Working indicator refreshed: ${mode}`, "info");
				return;
			}

			const nextMode = parseMode(raw);
			if (!nextMode) {
				ctx.ui.notify("Usage: /working-indicator [k2000|none|reset]", "error");
				return;
			}

			mode = nextMode;
			applyMode(mode, ctx);
			ctx.ui.notify(`Working indicator set: ${mode}`, "info");
		},
	});
}
