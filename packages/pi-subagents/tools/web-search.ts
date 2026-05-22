/**
 * Web search tool for subagent — wraps Tavily API.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const API_BASE = "https://api.tavily.com/search";

interface TavilyResult {
	title: string;
	url: string;
	content: string;
	score: number;
	published_date?: string;
}

interface TavilyResponse {
	query: string;
	answer?: string;
	results: TavilyResult[];
	response_time: number;
}

async function searchTavily(
	query: string,
	options: {
		depth?: string;
		maxResults?: number;
		includeAnswer?: boolean;
		includeDomains?: string;
		excludeDomains?: string;
		days?: number;
		topic?: string;
	},
): Promise<TavilyResponse> {
	const apiKey = process.env.TAVILY_API_KEY;
	if (!apiKey) {
		throw new Error("TAVILY_API_KEY not set. Get a key at https://tavily.com");
	}

	const body: Record<string, unknown> = {
		api_key: apiKey,
		query,
		search_depth: options.depth ?? "basic",
		max_results: options.maxResults ?? 5,
		include_answer: options.includeAnswer ?? true,
		topic: options.topic ?? "general",
	};

	if (options.includeDomains) {
		body.include_domains = options.includeDomains
			.split(",")
			.map((d) => d.trim());
	}
	if (options.excludeDomains) {
		body.exclude_domains = options.excludeDomains
			.split(",")
			.map((d) => d.trim());
	}
	if (options.days) body.days = options.days;

	const response = await fetch(API_BASE, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Tavily API error (${response.status}): ${err}`);
	}

	return response.json() as Promise<TavilyResponse>;
}

function formatResults(data: TavilyResponse): string {
	const lines: string[] = [];

	if (data.answer) {
		lines.push(`## Answer\n${data.answer}\n`);
	}

	lines.push(`## Results (${data.results.length})\n`);
	for (let i = 0; i < data.results.length; i++) {
		const r = data.results[i];
		lines.push(`### ${i + 1}. ${r.title}`);
		lines.push(`URL: ${r.url}`);
		if (r.published_date) lines.push(`Date: ${r.published_date}`);
		lines.push(`\n${r.content}\n`);
	}

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using Tavily. Returns relevant results with content snippets and optional AI-generated answer.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			depth: Type.Optional(
				Type.String({
					description: 'Search depth: "basic" (fast) or "advanced" (thorough)',
				}),
			),
			maxResults: Type.Optional(
				Type.Number({ description: "Number of results (1-20, default 5)" }),
			),
			includeAnswer: Type.Optional(
				Type.Boolean({ description: "Include AI-generated answer summary" }),
			),
			includeDomains: Type.Optional(
				Type.String({ description: "Comma-separated domains to include" }),
			),
			excludeDomains: Type.Optional(
				Type.String({ description: "Comma-separated domains to exclude" }),
			),
			days: Type.Optional(
				Type.Number({ description: "Only results from last N days" }),
			),
			topic: Type.Optional(
				Type.String({
					description: 'Search topic: "general", "news", or "finance"',
				}),
			),
		}),
		async execute(_toolCallId, params, _signal) {
			const data = await searchTavily(params.query, {
				depth: params.depth,
				maxResults: params.maxResults,
				includeAnswer: params.includeAnswer,
				includeDomains: params.includeDomains,
				excludeDomains: params.excludeDomains,
				days: params.days,
				topic: params.topic,
			});

			return {
				content: [{ type: "text", text: formatResults(data) }],
				details: { results: data.results, answer: data.answer },
			};
		},
	});
}
