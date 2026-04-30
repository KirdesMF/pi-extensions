import { readFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

const CUSTOM_TYPE = "styled-user-prompt";
const CAVEMAN_CONTEXT_TYPE = "caveman-context";
const CAVEMAN_STATE_ENTRY_KEY = "caveman-state";
const CAVEMAN_SKILL_PATH = "/Users/kirdes/.agents/skills/caveman/SKILL.md";
const CAVEMAN_LEVELS = new Set([
	"lite",
	"full",
	"ultra",
	"wenyan-lite",
	"wenyan-full",
	"wenyan-ultra",
]);
const LEFT_BORDER_CHAR = "▎";
const Y_PADDING = 1;

function padRightAnsi(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return text;
	return text + " ".repeat(width - w);
}

function getActiveCavemanMode(ctx: ExtensionContext): string | null {
	let mode: string | null = null;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== CAVEMAN_STATE_ENTRY_KEY)
			continue;
		const data = entry.data as { mode?: string } | undefined;
		if (!data?.mode) continue;
		if (data.mode === "off") mode = null;
		else if (CAVEMAN_LEVELS.has(data.mode)) mode = data.mode;
	}
	return mode;
}

function buildCavemanPrompt(mode: string, skillContent: string): string {
	return `

IMPORTANT: Caveman mode is active for this turn.
Active caveman level: ${mode}.
Follow the caveman skill below exactly. This instruction has priority over normal tone/style preferences unless the user explicitly asks to stop caveman mode.

${skillContent}
`;
}

export default function customPiUiExtension(pi: ExtensionAPI) {
	let cavemanSkillContent = "";
	try {
		cavemanSkillContent = readFileSync(CAVEMAN_SKILL_PATH, "utf8");
	} catch {}
	// Render custom prompt box with colored left border.
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const detailText =
			typeof message.details === "object" &&
			message.details !== null &&
			"displayText" in message.details &&
			typeof (message.details as { displayText?: unknown }).displayText ===
				"string"
				? ((message.details as { displayText: string }).displayText ?? "")
				: "";
		const renderedText = detailText || content;

		return {
			invalidate() {},
			render(width: number): string[] {
				if (width <= 2) {
					return [theme.fg("accent", LEFT_BORDER_CHAR)];
				}

				const innerWidth = Math.max(1, width - 2); // border + content
				const contentWidth = innerWidth - 1;
				const wrapped = wrapTextWithAnsi(renderedText || " ", contentWidth);
				const border = theme.fg("accent", LEFT_BORDER_CHAR);

				const renderLine = (line: string): string => {
					const padded = padRightAnsi(line, contentWidth);
					const bgContent = theme.bg("userMessageBg", ` ${padded}`);
					return `${border}${bgContent}`;
				};

				const lines: string[] = [];
				for (let i = 0; i < Y_PADDING; i++) lines.push(renderLine(""));
				for (const line of wrapped) lines.push(renderLine(line));
				for (let i = 0; i < Y_PADDING; i++) lines.push(renderLine(""));
				return lines;
			},
			handleInput() {},
		};
	});

	// Intercept normal text input and submit styled custom bubble as actual prompt.
	pi.on("input", async (event, ctx) => {
		// Avoid loops for extension-generated messages.
		if (event.source === "extension") return { action: "continue" as const };

		const text = event.text ?? "";
		const trimmed = text.trim();

		// Keep built-in handling for commands, bash mode, and image prompts.
		if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("!"))
			return { action: "continue" as const };
		if ((event.images?.length ?? 0) > 0) return { action: "continue" as const };

		const deliverAs = ctx.isIdle() ? undefined : "steer";

		const cavemanMode = getActiveCavemanMode(ctx);
		if (cavemanMode && cavemanSkillContent) {
			pi.sendMessage(
				{
					customType: CAVEMAN_CONTEXT_TYPE,
					content: buildCavemanPrompt(cavemanMode, cavemanSkillContent),
					display: false,
				},
				deliverAs ? { deliverAs } : undefined,
			);
		}

		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: text,
				display: true,
				details: { displayText: text },
			},
			deliverAs
				? { deliverAs }
				: {
						triggerTurn: true,
						deliverAs: "steer",
					},
		);

		return { action: "handled" as const };
	});
}
