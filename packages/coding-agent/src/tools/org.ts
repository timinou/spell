/**
 * Org tool adapter — wraps the @oh-my-pi/pi-org tool for use in coding-agent.
 *
 * Reads org config from settings + project-local .spell/config.yml, resolves
 * categories relative to the project root, and optionally starts an Emacs
 * daemon for advanced operations.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
} from "@oh-my-pi/pi-agent-core";
import type { EmacsSession, OrgConfig, OrgItem, OrgSessionContext, OrgToolDefinition } from "@oh-my-pi/pi-org";
import { createOrgTool, DEFAULT_ORG_CONFIG, detectEmacs, startEmacsSession } from "@oh-my-pi/pi-org";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine } from "../tui/status-line";
import type { ToolSession } from ".";
import { formatOrgQueryResult, renderItemOrg } from "./org-format";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";

// Path to the elisp directory shipped with the pi-org package.
// import.meta.dir = packages/coding-agent/src/tools — navigate to workspace root then pi-org
const ELISP_DIR = new URL("../../../org/elisp", import.meta.url).pathname;

// =============================================================================
// Schema
// =============================================================================

const orgSchema = Type.Object({
	command: Type.String({
		description:
			"Subcommand: init | create | query | get | update | note | set | validate | dashboard | wave | graph | archive",
	}),
	// create/update params
	title: Type.Optional(Type.String({ description: "Item title (create, or update to rename)" })),
	category: Type.Optional(
		Type.String({ description: "Category name or prefix (defaults to first configured category on create)" }),
	),
	state: Type.Optional(Type.String({ description: "TODO state" })),
	properties: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Properties map" })),
	body: Type.Optional(Type.String({ description: "Body text -- create: initial body; update: full replacement" })),
	append: Type.Optional(Type.String({ description: "Text to append to item body (update)" })),
	section: Type.Optional(
		Type.String({
			description: "Target heading (:raw-value) for section-scoped update (requires body or append)",
		}),
	),
	file: Type.Optional(
		Type.String({
			description: "Target file basename (create), or absolute path hint to skip scan (update/note/set)",
		}),
	),
	// query params
	dir: Type.Optional(Type.String({ description: "Org dir filter" })),
	priority: Type.Optional(Type.String({ description: "Priority filter (#A/#B/#C)" })),
	layer: Type.Optional(Type.String({ description: "Layer filter" })),
	agent: Type.Optional(Type.String({ description: "Agent filter" })),
	query: Type.Optional(Type.String({ description: "Keyword query syntax: 'todo:DOING tags:auth priority:>=B'" })),
	ql: Type.Optional(Type.String({ description: "Raw org-ql sexp for advanced queries (e.g. '(effort >= \"2h\")')" })),
	includeBody: Type.Optional(Type.Boolean({ description: "Include body text in query results" })),
	// get/update/set/note params
	id: Type.Optional(Type.String({ description: "Task CUSTOM_ID" })),
	note: Type.Optional(Type.String({ description: "Dated note text (note cmd, or appended on state change)" })),
	property: Type.Optional(Type.String({ description: "Property name (set)" })),
	value: Type.Optional(Type.String({ description: "Property value (set)" })),
});

type OrgParams = Static<typeof orgSchema>;

interface OrgCallPreview {
	description: string;
	meta: string[];
}

// =============================================================================
// Tool class
// =============================================================================

export class OrgTool implements AgentTool<typeof orgSchema, { error?: boolean }, Theme> {
	readonly name = "org";
	readonly label = "Org";
	readonly description: string;
	readonly parameters = orgSchema;
	readonly lenientArgValidation = true;

	#inner: OrgToolDefinition;

	constructor(session: ToolSession) {
		const projectRoot = session.cwd ?? getProjectDir();
		const config = loadOrgConfig(session);

		const emacsPathSetting = session.settings.get("org.emacsPath") as string | undefined;
		const emacsPath = emacsPathSetting || undefined;
		const sessionId = session.getSessionId?.() ?? "default";

		this.#inner = createOrgTool(projectRoot, config, makeEmacsFactory(emacsPath, projectRoot, sessionId), () =>
			buildSessionContext(session),
		);
		this.description = this.#inner.description;
	}

	renderCall(args: OrgParams, _options: RenderResultOptions, theme: Theme): Component {
		const preview = buildOrgCallPreview(args as Record<string, unknown>);
		const text = renderStatusLine(
			{ icon: "pending", title: "Org", description: preview.description, meta: preview.meta },
			theme,
		);
		return new Text(text, 0, 0);
	}

	async execute(
		_toolCallId: string,
		params: OrgParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const args = params as Record<string, unknown>;
		try {
			const result = await this.#inner.execute(args);
			const text = formatOrgResult(result);
			const isError =
				typeof result === "object" &&
				result !== null &&
				"error" in result &&
				(result as Record<string, unknown>).error === true;
			return {
				content: [{ type: "text", text }],
				details: isError ? { error: true } : undefined,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("org tool error", { error: msg });
			return {
				content: [{ type: "text", text: JSON.stringify({ error: true, message: msg }) }],
				details: { error: true },
			};
		}
	}

	renderResult(result: AgentToolResult): Component {
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { type: string; text: string }).text)
			.join("");
		return new Text(replaceTabs(text).slice(0, 500), 0, 0);
	}

	async dispose(): Promise<void> {
		await this.#inner.dispose?.();
	}
}

// =============================================================================
// Helpers
// =============================================================================

function makeEmacsFactory(
	emacsPath: string | undefined,
	projectRoot: string,
	sessionId: string,
): () => Promise<EmacsSession> {
	return async () => {
		const detection = await detectEmacs(emacsPath);
		if (!detection.found || !detection.meetsMinimum || !detection.socatFound) {
			const errors =
				detection.errors.length > 0
					? detection.errors.join("; ")
					: "Emacs not found or does not meet minimum version";
			throw new Error(`org: Emacs not available — ${errors}`);
		}
		return startEmacsSession(detection.path!, projectRoot, sessionId, ELISP_DIR);
	};
}

function loadOrgConfig(session: ToolSession): OrgConfig {
	const rawKeywords = session.settings.get("org.todoKeywords") as readonly string[] | string[] | undefined;
	const todoKeywords = rawKeywords ? [...rawKeywords] : undefined;

	return {
		...DEFAULT_ORG_CONFIG,
		todoKeywords: todoKeywords && todoKeywords.length > 0 ? todoKeywords : [...DEFAULT_ORG_CONFIG.todoKeywords],
	};
}

// =============================================================================
// Session context builder
// =============================================================================

function buildSessionContext(session: ToolSession): OrgSessionContext {
	return {
		sessionId: session.getSessionId?.() ?? undefined,
		transcriptPath: session.getSessionFile() ?? undefined,
		initialMessage: session.getFirstUserMessage?.() ?? undefined,
	};
}

function buildOrgCallPreview(args: Record<string, unknown>): OrgCallPreview {
	const description = previewArgValue(args.command, TRUNCATE_LENGTHS.SHORT) ?? "request";
	const meta: string[] = [];

	switch (description) {
		case "create":
			pushMeta(meta, "category", args.category, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "title", args.title);
			pushPathMeta(meta, args.file);
			pushMeta(meta, "state", args.state, TRUNCATE_LENGTHS.SHORT);
			break;
		case "query":
			pushMeta(meta, "query", args.query);
			pushMeta(meta, "ql", args.ql);
			pushMeta(meta, "state", args.state, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "category", args.category, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "dir", args.dir, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "priority", args.priority, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "layer", args.layer, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "agent", args.agent, TRUNCATE_LENGTHS.SHORT);
			if (args.includeBody === true) meta.push("includeBody:true");
			break;
		case "get":
		case "note":
			pushMeta(meta, "id", args.id);
			break;
		case "update":
			pushMeta(meta, "id", args.id);
			pushMeta(meta, "state", args.state, TRUNCATE_LENGTHS.SHORT);
			pushMeta(meta, "title", args.title);
			pushMeta(meta, "section", args.section, TRUNCATE_LENGTHS.SHORT);
			pushPathMeta(meta, args.file);
			if (previewArgValue(args.append, TRUNCATE_LENGTHS.SHORT)) meta.push("append");
			if (previewArgValue(args.note, TRUNCATE_LENGTHS.SHORT)) meta.push("note");
			break;
		case "set": {
			pushMeta(meta, "id", args.id);
			const property = previewArgValue(args.property, TRUNCATE_LENGTHS.SHORT);
			const value = previewArgValue(args.value, TRUNCATE_LENGTHS.SHORT);
			if (property && value) {
				meta.push(truncateToWidth(`${property}=${value}`, TRUNCATE_LENGTHS.CONTENT));
			}
			break;
		}
		case "init":
			pushMeta(meta, "category", args.category, TRUNCATE_LENGTHS.SHORT);
			break;
		case "dashboard":
		case "wave":
		case "graph":
		case "archive":
		case "validate":
			pushMeta(meta, "dir", args.dir, TRUNCATE_LENGTHS.SHORT);
			break;
		default:
			pushMeta(meta, "id", args.id);
			pushMeta(meta, "query", args.query);
			pushMeta(meta, "ql", args.ql);
			break;
	}

	return { description, meta };
}

function pushMeta(meta: string[], label: string, value: unknown, width: number = TRUNCATE_LENGTHS.CONTENT): void {
	const preview = previewArgValue(value, width);
	if (!preview) return;
	meta.push(truncateToWidth(`${label}:${preview}`, width));
}

function pushPathMeta(meta: string[], value: unknown): void {
	if (typeof value !== "string" || value.trim().length === 0) return;
	meta.push(truncateToWidth(`file:${shortenPath(value.trim())}`, TRUNCATE_LENGTHS.CONTENT));
}

function previewArgValue(value: unknown, width: number = TRUNCATE_LENGTHS.CONTENT): string | undefined {
	if (typeof value === "string") {
		const clean = replaceTabs(value).trim();
		return clean ? truncateToWidth(clean, width) : undefined;
	}
	if (Array.isArray(value)) {
		const parts = value.map(part => previewArgValue(part, width)).filter((part): part is string => Boolean(part));
		if (parts.length === 0) return undefined;
		return truncateToWidth(parts.join(","), width);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

// =============================================================================
// Output formatter
// =============================================================================

/**
 * Convert an inner org tool result to a string suitable for the LLM.
 *
 * - Query results ({ items, total }): org-mode text with byte budget.
 * - Section update results with `fileContent`: full org file text.
 * - Single-item get results ({ item }): org-mode text, no budget.
 * - Everything else (create, update, dashboard, etc.): JSON.
 */
export function formatOrgResult(result: unknown): string {
	if (
		typeof result === "object" &&
		result !== null &&
		"items" in result &&
		Array.isArray((result as Record<string, unknown>).items)
	) {
		const r = result as { items: OrgItem[]; total: number };
		return formatOrgQueryResult(r.items, r.total ?? r.items.length);
	}

	if (
		typeof result === "object" &&
		result !== null &&
		"fileContent" in result &&
		typeof (result as Record<string, unknown>).fileContent === "string"
	) {
		return (result as { fileContent: string }).fileContent;
	}

	if (
		typeof result === "object" &&
		result !== null &&
		"item" in result &&
		typeof (result as Record<string, unknown>).item === "object"
	) {
		const item = (result as { item: OrgItem }).item;
		return renderItemOrg(item, true, Infinity);
	}

	// Mutation results (create, update, set, note)
	if (typeof result === "object" && result !== null && "success" in result) {
		const r = result as Record<string, unknown>;
		const parts: string[] = [];
		if (r.success) parts.push("success");
		if (r.id) parts.push(`id: ${r.id}`);
		if (Array.isArray(r.updated)) parts.push(`updated: ${(r.updated as string[]).join(", ")}`);
		if (typeof r.file === "string") parts.push(`file: ${r.file}`);
		if (typeof r.section === "string") parts.push(`section: ${r.section}`);
		if (typeof r.state === "string") parts.push(`state: ${r.state}`);
		if (typeof r.category === "string") parts.push(`category: ${r.category}`);
		return parts.join("\n");
	}

	// Error results
	if (typeof result === "object" && result !== null && "error" in result) {
		const r = result as Record<string, unknown>;
		return `error: ${r.message ?? "unknown"}${r.code ? ` (${r.code})` : ""}`;
	}

	return JSON.stringify(result, null, 2);
}
