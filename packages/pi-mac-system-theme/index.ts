import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execAsync = promisify(exec);

async function isDarkMode(): Promise<boolean> {
	try {
		const { stdout } = await execAsync(
			"osascript -e 'tell application \"System Events\" to tell appearance preferences to return dark mode'",
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

export default function macSystemThemeExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const nextTheme: "dark" | "light" = (await isDarkMode()) ? "dark" : "light";
		ctx.ui.setTheme(nextTheme);

		// If you want live syncing while Pi is running, re-enable polling:
		// const POLL_MS = 5000;
		// const intervalId = setInterval(async () => {
		// 	const theme: "dark" | "light" = (await isDarkMode()) ? "dark" : "light";
		// 	ctx.ui.setTheme(theme);
		// }, POLL_MS);
		// Then clear it in session_shutdown.
	});
}
