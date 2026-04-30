import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const MAX_README_CHARS = 12_000;
const MAX_SECTION_CHARS = 4_000;

type PackageMetadata = {
	name?: string;
	description?: string;
	homepage?: string;
	repository?:
		| string
		| {
				type?: string;
				url?: string;
		  };
	keywords?: Array<string>;
	readme?: string;
	"dist-tags"?: {
		latest?: string;
	};
	versions?: Record<
		string,
		{
			peerDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
			bin?: string | Record<string, string>;
		}
	>;
};

function normalizePackageName(packageName: string): string {
	return packageName.trim().replace(/^npm:/, "");
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n...[truncated]`;
}

function getRepositoryUrl(metadata: PackageMetadata): string | undefined {
	const repository = metadata.repository;
	if (typeof repository === "string") return repository;
	return repository?.url;
}

function normalizeRepositoryUrl(
	repositoryUrl: string | undefined,
): string | undefined {
	if (!repositoryUrl) return undefined;
	return repositoryUrl
		.replace(/^git\+/, "")
		.replace(/\.git$/, "")
		.replace(/^git:github\.com\//, "https://github.com/");
}

function extractHeadings(
	markdown: string,
): Array<{ heading: string; content: string }> {
	const lines = markdown.split("\n");
	const sections: Array<{ heading: string; content: string }> = [];
	let currentHeading = "Intro";
	let currentLines: Array<string> = [];

	for (const line of lines) {
		if (/^#{1,6}\s+/.test(line)) {
			sections.push({
				heading: currentHeading,
				content: currentLines.join("\n").trim(),
			});
			currentHeading = line.replace(/^#{1,6}\s+/, "").trim();
			currentLines = [];
			continue;
		}
		currentLines.push(line);
	}

	sections.push({
		heading: currentHeading,
		content: currentLines.join("\n").trim(),
	});
	return sections.filter((section) => section.content.length > 0);
}

function extractRelevantReadme(
	markdown: string,
	topic: string | undefined,
): string {
	const normalizedTopic = topic?.trim().toLowerCase();
	const sections = extractHeadings(markdown);
	if (!normalizedTopic) {
		const preferred = sections.filter((section) =>
			[
				"install",
				"installation",
				"setup",
				"usage",
				"configuration",
				"config",
			].some((keyword) => section.heading.toLowerCase().includes(keyword)),
		);
		const chosen = preferred.length > 0 ? preferred : sections.slice(0, 3);
		return truncate(
			chosen
				.map((section) => `## ${section.heading}\n${section.content}`)
				.join("\n\n"),
			MAX_SECTION_CHARS,
		);
	}

	const matching = sections.filter(
		(section) =>
			section.heading.toLowerCase().includes(normalizedTopic) ||
			section.content.toLowerCase().includes(normalizedTopic),
	);
	const chosen =
		matching.length > 0 ? matching.slice(0, 3) : sections.slice(0, 3);
	return truncate(
		chosen
			.map((section) => `## ${section.heading}\n${section.content}`)
			.join("\n\n"),
		MAX_SECTION_CHARS,
	);
}

async function fetchPackageMetadata(
	packageName: string,
): Promise<PackageMetadata> {
	const response = await fetch(
		`${NPM_REGISTRY_URL}/${encodeURIComponent(packageName)}`,
	);
	if (!response.ok) {
		throw new Error(`npm registry request failed: ${response.status}`);
	}
	return (await response.json()) as PackageMetadata;
}

export default function packageResearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "npm_info",
		label: "NPM Info",
		description:
			"Fetch npm package metadata, latest version, homepage, repository, and dependency information.",
		promptSnippet:
			"Look up npm package metadata before installing or configuring a package.",
		promptGuidelines: [
			"Use npm_info when user asks to install, compare, or configure an npm package.",
			"Use package_readme after npm_info when install or config instructions are needed.",
		],
		parameters: Type.Object({
			packageName: Type.String({
				description: "npm package name, for example oxlint or @scope/pkg",
			}),
		}),
		async execute(_toolCallId, params) {
			const packageName = normalizePackageName(params.packageName);
			const metadata = await fetchPackageMetadata(packageName);
			const latestVersion = metadata["dist-tags"]?.latest;
			const latest = latestVersion
				? metadata.versions?.[latestVersion]
				: undefined;
			const repository = normalizeRepositoryUrl(getRepositoryUrl(metadata));
			const homepage = metadata.homepage;
			const keywords = metadata.keywords?.slice(0, 20) ?? [];

			const summary = [
				`name: ${metadata.name ?? packageName}`,
				latestVersion ? `latest: ${latestVersion}` : undefined,
				metadata.description
					? `description: ${metadata.description}`
					: undefined,
				homepage ? `homepage: ${homepage}` : undefined,
				repository ? `repository: ${repository}` : undefined,
				keywords.length > 0 ? `keywords: ${keywords.join(", ")}` : undefined,
				latest?.peerDependencies
					? `peerDependencies: ${JSON.stringify(latest.peerDependencies, null, 2)}`
					: undefined,
				latest?.dependencies
					? `dependencies: ${JSON.stringify(latest.dependencies, null, 2)}`
					: undefined,
				latest?.bin ? `bin: ${JSON.stringify(latest.bin, null, 2)}` : undefined,
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: {
					packageName,
					latestVersion,
					homepage,
					repository,
					keywords,
					peerDependencies: latest?.peerDependencies ?? {},
					dependencies: latest?.dependencies ?? {},
					bin: latest?.bin ?? null,
				},
			};
		},
	});

	pi.registerTool({
		name: "package_readme",
		label: "Package README",
		description:
			"Fetch relevant npm package README sections for install, usage, and configuration.",
		promptSnippet: "Read install and config docs from npm package README.",
		promptGuidelines: [
			"Use package_readme when user asks how to install or configure a package.",
			"Pass topic like install, config, vite, eslint, typescript, usage when relevant.",
		],
		parameters: Type.Object({
			packageName: Type.String({
				description: "npm package name, for example oxlint or @scope/pkg",
			}),
			topic: Type.Optional(
				Type.String({
					description:
						"Optional topic like install, config, usage, vite, eslint, typescript",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const packageName = normalizePackageName(params.packageName);
			const metadata = await fetchPackageMetadata(packageName);
			const readme = metadata.readme?.trim();
			if (!readme) {
				return {
					content: [
						{ type: "text", text: `No README found for ${packageName}.` },
					],
					details: { packageName, topic: params.topic ?? null },
				};
			}

			const relevant = extractRelevantReadme(
				truncate(readme, MAX_README_CHARS),
				params.topic,
			);
			return {
				content: [{ type: "text", text: relevant }],
				details: {
					packageName,
					topic: params.topic ?? null,
				},
			};
		},
	});
}
