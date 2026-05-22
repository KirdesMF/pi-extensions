/**
 * Web fetch tool for subagent — fetches full page content from a URL.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

async function fetchPage(
	url: string,
): Promise<{ title: string; text: string }> {
	const response = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
		signal: AbortSignal.timeout(15000),
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const html = await response.text();

	// Extract title
	const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
	const title = titleMatch?.[1]?.trim() || url;

	// Basic HTML-to-text: remove scripts, styles, then strip tags
	let text = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	// Truncate to ~50KB
	const maxBytes = 50 * 1024;
	if (Buffer.byteLength(text, "utf-8") > maxBytes) {
		text = text.slice(0, maxBytes);
		while (Buffer.byteLength(text, "utf-8") > maxBytes) {
			text = text.slice(0, -1);
		}
		text += "\n\n[Content truncated]";
	}

	return { title, text };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch and extract text content from a web page. Returns page title and main text content.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
		}),
		async execute(_toolCallId, params, _signal) {
			const { title, text } = await fetchPage(params.url);

			return {
				content: [{ type: "text", text: `## ${title}\n\n${text}` }],
				details: { url: params.url, title },
			};
		},
	});
}
