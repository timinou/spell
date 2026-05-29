import * as path from "node:path";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";

export type ContextPressureCategory =
	| "precision"
	| "source-exploration"
	| "source-search"
	| "transcript-spelunking"
	| "planning-churn"
	| "other";

export type ContextPressurePresentation = "inline" | "summary-first";

export type ContextPressurePersistence = "allow-raw" | "summary-only" | "deny-raw";

export interface ContextPressureMeta {
	category: ContextPressureCategory;
	presentation: ContextPressurePresentation;
	persistence: ContextPressurePersistence;
	autoEscalate: boolean;
	reason: string;
	summary: string;
	followUp: string[];
}

export interface ContextPressureSourceMetaLike {
	type: "path" | "url" | "internal";
	value: string;
}

export interface ContextPressureTruncationMetaLike {
	artifactUri?: string;
}

export interface ContextPressureOutputMetaLike {
	source?: ContextPressureSourceMetaLike;
	truncation?: ContextPressureTruncationMetaLike;
	contextPressure?: ContextPressureMeta;
}

export interface ContextPressureInput {
	toolName: string;
	params?: unknown;
	detailsMeta?: ContextPressureOutputMetaLike;
	text?: string;
	isError?: boolean;
}

const SOURCE_FILE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".rs",
	".py",
	".pyi",
	".ex",
	".exs",
	".go",
	".java",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".json",
	".kdl",
	".yaml",
	".yml",
	".toml",
	".md",
	".mdx",
	".org",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function truncateSummary(value: string, max = 220): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 3).trimEnd()}...`;
}

function extractTextFromContent(message: Pick<ToolResultMessage<unknown>, "content">): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
}

function extractFirstMeaningfulLine(text: string): string | undefined {
	const lines = text.split(/\r?\n/u);
	for (const rawLine of lines) {
		const line = normalizeWhitespace(rawLine.replace(/^#+\s*/u, "").replace(/^[-*>]+\s*/u, ""));
		if (!line || line === "```") continue;
		return truncateSummary(line, 180);
	}
	return undefined;
}

function normalizePathLike(value: string): string {
	return value.replace(/\\/gu, "/").toLowerCase();
}

export function isTranscriptOrLogPath(rawPath: string): boolean {
	const normalized = normalizePathLike(rawPath);
	if (normalized.startsWith("jobs://")) return true;
	if (normalized.includes("/.spell/agent/sessions/")) return true;
	if (normalized.includes("/.spell/logs/")) return true;
	if (normalized.includes("/.spell/graph/")) return true;
	return normalized.endsWith(".jsonl") && normalized.includes(".spell");
}

function isSourceLikePath(rawPath: string): boolean {
	const normalized = rawPath.replace(/\\/gu, "/");
	const ext = path.extname(normalized).toLowerCase();
	if (SOURCE_FILE_EXTENSIONS.has(ext)) return true;
	return /(?:^|\/)(?:src|test|tests|spec|specs|packages)\//u.test(normalized);
}

function describePath(rawPath: string): string {
	const normalized = rawPath.replace(/\\/gu, "/");
	return normalized.length === 0 ? "." : normalized;
}

function describeCommand(command: string): string {
	return truncateSummary(normalizeWhitespace(command), 96);
}

function buildSummary(params: { sentence: string; followUp: string[]; artifactUri?: string }): string {
	const parts = [params.sentence.trim(), ...params.followUp.map(item => item.trim())].filter(Boolean);
	if (params.artifactUri) parts.push(`Full output: ${params.artifactUri}`);
	return truncateSummary(parts.join(" "), 360);
}

function buildMeta(params: {
	category: ContextPressureCategory;
	presentation: ContextPressurePresentation;
	persistence: ContextPressurePersistence;
	reason: string;
	summary: string;
	followUp: string[];
}): ContextPressureMeta {
	return {
		category: params.category,
		presentation: params.presentation,
		persistence: params.persistence,
		autoEscalate: params.presentation === "summary-first",
		reason: params.reason,
		summary: params.summary,
		followUp: params.followUp,
	};
}

function classifyRead(input: ContextPressureInput): ContextPressureMeta | undefined {
	const params = asRecord(input.params);
	const rawPath = typeof params?.path === "string" ? params.path : input.detailsMeta?.source?.value;
	if (!rawPath) return undefined;
	const artifactUri = input.detailsMeta?.truncation?.artifactUri;
	if (isTranscriptOrLogPath(rawPath)) {
		const followUp = ["Use offset/limit or a tighter follow-up only when exact lines matter."];
		return buildMeta({
			category: "transcript-spelunking",
			presentation: "summary-first",
			persistence: "deny-raw",
			reason: "Transcript/log reads create high-noise context with weak durable value.",
			summary: buildSummary({
				sentence: `Read transcript/log resource ${describePath(rawPath)}. Raw body suppressed as transcript spelunking.`,
				followUp,
				artifactUri,
			}),
			followUp,
		});
	}
	if (!isSourceLikePath(rawPath)) {
		return buildMeta({
			category: "precision",
			presentation: "inline",
			persistence: "allow-raw",
			reason: "Non-source reads often carry the exact bytes the caller needs.",
			summary: `Read ${describePath(rawPath)}.`,
			followUp: [],
		});
	}
	const hasExplicitRange = typeof params?.offset === "number" || typeof params?.limit === "number";
	if (hasExplicitRange) {
		return buildMeta({
			category: "precision",
			presentation: "inline",
			persistence: "allow-raw",
			reason: "Explicit read ranges are precision inspections whose literal lines are the contract.",
			summary: `Read explicit range from ${describePath(rawPath)}.`,
			followUp: [],
		});
	}
	const followUp = ["Prefer find/get with offset/limit for exact lines."];
	return buildMeta({
		category: "source-exploration",
		presentation: "summary-first",
		persistence: "summary-only",
		reason: "Untargeted source/test reads behave like raw repo browsing and inflate fresh input.",
		summary: buildSummary({
			sentence: `Read source-like file ${describePath(rawPath)} without explicit range. Use find/get or precise follow-up instead of exploratory browsing.`,
			followUp,
			artifactUri,
		}),
		followUp,
	});
}

function classifyGrep(input: ContextPressureInput): ContextPressureMeta | undefined {
	const params = asRecord(input.params);
	const rawPath = typeof params?.path === "string" && params.path.trim().length > 0 ? params.path : ".";
	const artifactUri = input.detailsMeta?.truncation?.artifactUri;
	if (isTranscriptOrLogPath(rawPath)) {
		const followUp = ["Use a purpose-built summary path or narrow the transcript/log scope first."];
		return buildMeta({
			category: "transcript-spelunking",
			presentation: "summary-first",
			persistence: "deny-raw",
			reason: "Transcript/log grep is a cross-tool noise class, not ordinary source search.",
			summary: buildSummary({
				sentence: `Ran grep against transcript/log scope ${describePath(rawPath)}. Raw match sets suppressed as transcript spelunking.`,
				followUp,
				artifactUri,
			}),
			followUp,
		});
	}
	const hasNarrowScope =
		(typeof params?.path === "string" && params.path.trim().length > 0 && params.path.trim() !== ".") ||
		typeof params?.glob === "string" ||
		typeof params?.type === "string";
	if (hasNarrowScope) {
		return buildMeta({
			category: "precision",
			presentation: "inline",
			persistence: "allow-raw",
			reason: "Narrow grep scopes are precision search aids.",
			summary: `Ran narrow grep in ${describePath(rawPath)}.`,
			followUp: [],
		});
	}
	const pattern =
		typeof params?.pattern === "string" ? truncateSummary(normalizeWhitespace(params.pattern), 72) : "pattern";
	const isTranscriptSpelunking = isTranscriptOrLogPath(rawPath);
	const followUp = isTranscriptSpelunking
		? ["Use a purpose-built summary path or narrow the transcript/log scope first."]
		: ["Stage file hits first, then narrow path/glob/type before reading content."];
	return buildMeta({
		category: isTranscriptSpelunking ? "transcript-spelunking" : "source-search",
		presentation: "summary-first",
		persistence: isTranscriptSpelunking ? "deny-raw" : "summary-only",
		reason: isTranscriptSpelunking
			? "Transcript/log grep is a cross-tool noise class, not ordinary source search."
			: "Broad grep exploration is useful, but raw match dumps are low-value context churn.",
		summary: buildSummary({
			sentence: isTranscriptSpelunking
				? `Ran grep against transcript/log scope ${describePath(rawPath)}. Raw match sets suppressed as transcript spelunking.`
				: `Ran broad grep for ${JSON.stringify(pattern)} in ${describePath(rawPath)}. Stage file hits before reading content.`,
			followUp,
			artifactUri,
		}),
		followUp,
	});
}

function classifyBash(input: ContextPressureInput): ContextPressureMeta | undefined {
	const params = asRecord(input.params);
	const command = typeof params?.command === "string" ? params.command.trim() : undefined;
	if (!command) return undefined;
	const summaryCommand = describeCommand(command);
	const artifactUri = input.detailsMeta?.truncation?.artifactUri;
	if (!artifactUri) {
		return buildMeta({
			category: "other",
			presentation: "inline",
			persistence: input.isError ? "summary-only" : "allow-raw",
			reason: "Bash output fit the inline budget; raw bytes kept.",
			summary: `Ran bash command ${JSON.stringify(summaryCommand)}.`,
			followUp: [],
		});
	}
	const followUp = [`Read ${artifactUri} for exact bytes when needed.`];
	return buildMeta({
		category: "other",
		presentation: "summary-first",
		persistence: "summary-only",
		reason: "Bash output exceeded the inline budget and was spilled to an artifact.",
		summary: buildSummary({
			sentence: `Ran bash command ${JSON.stringify(summaryCommand)}; output spilled to artifact.`,
			followUp,
			artifactUri,
		}),
		followUp,
	});
}

function classifyOrg(input: ContextPressureInput): ContextPressureMeta | undefined {
	const params = asRecord(input.params);
	const command = typeof params?.command === "string" ? params.command.trim() : undefined;
	if (!command) return undefined;
	const followUp = ["Keep exact IDs, states, and next-step guidance; avoid replaying full org bodies by default."];
	const category = "planning-churn" as const;
	if (["create", "update", "set", "note", "delete", "archive", "init"].includes(command)) {
		return buildMeta({
			category,
			presentation: "summary-first",
			persistence: "summary-only",
			reason:
				"Org mutations are high-chatter acknowledgements whose durable value is the state change, not the echoed body.",
			summary: buildSummary({
				sentence: `Ran org ${command} mutation. Persist state-change facts, not full org text.`,
				followUp,
			}),
			followUp,
		});
	}
	if (["query", "get", "wave", "graph", "dashboard", "validate", "validate-plan"].includes(command)) {
		return buildMeta({
			category,
			presentation: "summary-first",
			persistence: "summary-only",
			reason: "Org queries/waves/graphs often repeat with little state change and should stay compact-first.",
			summary: buildSummary({
				sentence: `Ran org ${command}. Prefer compact IDs/counts and memoized next-step guidance.`,
				followUp,
			}),
			followUp,
		});
	}
	return undefined;
}

export function classifyContextPressure(input: ContextPressureInput): ContextPressureMeta | undefined {
	switch (input.toolName) {
		case "read":
			return classifyRead(input);
		case "grep":
			return classifyGrep(input);
		case "bash":
			return classifyBash(input);
		case "org":
			return classifyOrg(input);
		default:
			return undefined;
	}
}

export function getToolResultOutputMeta(details: unknown): ContextPressureOutputMetaLike | undefined {
	const record = asRecord(details);
	const meta = asRecord(record?.meta);
	if (!meta) return undefined;
	return meta as ContextPressureOutputMetaLike;
}

export function getContextPressureSummaryText(message: ToolResultMessage<unknown>): string | undefined {
	const meta = getToolResultOutputMeta(message.details);
	if (meta?.contextPressure?.summary) return meta.contextPressure.summary;
	const text = extractTextFromContent(message);
	const diagnosis = extractFirstMeaningfulLine(text);
	if (!diagnosis) return undefined;
	if (["bash", "read", "grep", "org"].includes(message.toolName)) {
		return truncateSummary(`${message.toolName} ${message.isError ? "failed" : "result"}: ${diagnosis}`, 320);
	}
	return undefined;
}

export function createMemorySafeToolResult(
	message: ToolResultMessage<unknown>,
	contextPressure?: ContextPressureMeta,
): ToolResultMessage<unknown> | undefined {
	const meta = getToolResultOutputMeta(message.details);
	const effectiveMeta = contextPressure
		? { ...(meta ?? {}), contextPressure: meta?.contextPressure ?? contextPressure }
		: meta;
	const effectiveDetails = asRecord(message.details) ? { ...(message.details as Record<string, unknown>) } : {};
	if (effectiveMeta) {
		effectiveDetails.meta = effectiveMeta;
	}
	const effectiveMessage: ToolResultMessage<unknown> = {
		...message,
		details: Object.keys(effectiveDetails).length > 0 ? effectiveDetails : undefined,
	};
	const summary = effectiveMeta?.contextPressure?.summary ?? getContextPressureSummaryText(effectiveMessage);
	if (!summary) return undefined;
	if (effectiveMeta?.contextPressure?.persistence === "allow-raw") return effectiveMessage;

	if (effectiveMeta) {
		effectiveDetails.meta = {
			...effectiveMeta,
			contextPressure: effectiveMeta.contextPressure ? { ...effectiveMeta.contextPressure, summary } : undefined,
		};
	}

	return {
		...effectiveMessage,
		content: [{ type: "text", text: summary }],
		details: Object.keys(effectiveDetails).length > 0 ? effectiveDetails : undefined,
	};
}
