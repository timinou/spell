/**
 * Org tool adapter — wraps the @oh-my-pi/pi-org tool for use in coding-agent.
 *
 * Reads org config from settings + project-local .spell/config.yml, resolves
 * categories relative to the project root.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
} from "@oh-my-pi/pi-agent-core";
import type { OrgConfig, OrgItem, OrgToolDefinition } from "@oh-my-pi/pi-org";
import { createOrgTool, DEFAULT_ORG_CONFIG } from "@oh-my-pi/pi-org";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine } from "../tui/status-line";
import type { ToolSession } from ".";
import { formatOrgQueryResult, renderItemOrg } from "./org-format";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";

const orgSchema = Type.Object({
	command: Type.String({
		description:
			"Subcommand: init | create | query | get | update | note | set | validate | dashboard | wave | graph | archive",
	}),
	title: Type.Optional(Type.String({ description: "Item title (create, or update to rename)" })),
	category: Type.Optional(
		Type.String({ description: "Category name or prefix (defaults to first configured category on create)" }),
	),
	state: Type.Optional(Type.String({ description: "TODO state" })),
	properties: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Properties map" })),
	body: Type.Optional(Type.String({ description: "Body text -- create: initial body; update: full replacement" })),
	append: Type.Optional(Type.String({ description: "Text to append to item body (update)" })),
	section: Type.Optional(
		Type.String({ description: "Target heading (:raw-value) for section-scoped update (requires body or append)" }),
	),
	file: Type.Optional(
		Type.String({
			description: "Target file basename (create), or absolute path hint to skip scan (update/note/set)",
		}),
	),
	dir: Type.Optional(Type.String({ description: "Org dir filter" })),
	priority: Type.Optional(Type.String({ description: "Priority filter (#A/#B/#C)" })),
	layer: Type.Optional(Type.String({ description: "Layer filter" })),
	agent: Type.Optional(Type.String({ description: "Agent filter" })),
	query: Type.Optional(Type.String({ description: "Keyword query syntax: 'todo:DOING tags:auth priority:>=B'" })),
	ql: Type.Optional(Type.String({ description: "Raw org-ql sexp for advanced queries (e.g. '(effort >= \"2h\")' )" })),
	includeBody: Type.Optional(Type.Boolean({ description: "Include body text in query results" })),
	sort: Type.Optional(
		Type.String({
			description:
				"Sort key(s), space-separated: priority, state/todo, id, category. Keys sort descending by default. Default: priority state id",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max items to return" })),
	offset: Type.Optional(Type.Number({ description: "Number of items to skip before returning" })),
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

type OrgToolDetails = { error?: boolean };

export class OrgTool implements AgentTool<typeof orgSchema, OrgToolDetails, Theme> {
	readonly name = "org";
	readonly label = "Org";
	get description(): string {
		return this.#inner.description;
	}
	readonly parameters = orgSchema;
	readonly lenientArgValidation = true;

	#session: ToolSession;
	#projectRoot: string;
	#inner: OrgToolDefinition;

	constructor(session: ToolSession) {
		this.#session = session;
		this.#projectRoot = session.cwd ?? getProjectDir();
		this.#inner = this.#createInner(this.#projectRoot);
	}

	renderCall(args: OrgParams, _options: RenderResultOptions, theme: Theme): Component {
		const preview = buildOrgCallPreview(args as Record<string, unknown>);
		return new Text(
			renderStatusLine(
				{ icon: "pending", title: "Org", description: preview.description, meta: preview.meta },
				theme,
			),
			0,
			0,
		);
	}

	async execute(
		_toolCallId: string,
		params: OrgParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		try {
			await this.#ensureInner();
			const result = await this.#inner.execute(params as Record<string, unknown>);
			const text = formatOrgResult(result);
			const isError =
				typeof result === "object" &&
				result !== null &&
				"error" in result &&
				(result as Record<string, unknown>).error === true;
			return { content: [{ type: "text", text }], details: isError ? { error: true } : undefined };
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

	#createInner(projectRoot: string): OrgToolDefinition {
		const config = loadOrgConfig(this.#session);
		return createOrgTool(projectRoot, config, { getSessionContext: () => buildSessionContext(this.#session) });
	}

	async #ensureInner(): Promise<void> {
		const projectRoot = this.#session.cwd ?? getProjectDir();
		if (projectRoot === this.#projectRoot) return;
		const nextInner = this.#createInner(projectRoot);
		const previousInner = this.#inner;
		this.#inner = nextInner;
		this.#projectRoot = projectRoot;
		await previousInner.dispose?.();
	}
}

function loadOrgConfig(session: ToolSession): OrgConfig {
	const rawKeywords = session.settings.get("org.todoKeywords") as readonly string[] | string[] | undefined;
	const todoKeywords = rawKeywords ? [...rawKeywords] : undefined;
	return {
		...DEFAULT_ORG_CONFIG,
		todoKeywords: todoKeywords && todoKeywords.length > 0 ? todoKeywords : [...DEFAULT_ORG_CONFIG.todoKeywords],
	};
}

function buildSessionContext(session: ToolSession) {
	return {
		sessionId: session.getSessionId?.() ?? undefined,
		transcriptPath: session.getSessionFile() ?? undefined,
		initialMessage: (session.taskDepth ?? 0) > 0 ? undefined : (session.getFirstUserMessage?.() ?? undefined),
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
			pushMeta(meta, "sort", args.sort, TRUNCATE_LENGTHS.SHORT);
			if (typeof args.limit === "number") meta.push(`limit:${args.limit}`);
			if (typeof args.offset === "number") meta.push(`offset:${args.offset}`);
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
			if (property && value) meta.push(truncateToWidth(`${property}=${value}`, TRUNCATE_LENGTHS.CONTENT));
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
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

export function formatOrgResult(result: unknown): string {
	const isObjectResult = typeof result === "object" && result !== null;
	const record = isObjectResult ? (result as Record<string, unknown>) : null;
	if (record && "wave_number" in record && Array.isArray(record.items)) {
		const items = record.items as Array<Record<string, unknown>>;
		const blockedItems = Array.isArray(record.blocked_items) ? record.blocked_items.length : 0;
		const lines = [
			`wave: ${String(record.wave_number)}`,
			`ready: ${items.length}`,
			`blocked: ${blockedItems}`,
			`completed: ${String(record.completed_count ?? 0)}/${String(record.total_count ?? items.length)}`,
		];
		for (const item of items)
			lines.push(
				`- ${typeof item.custom_id === "string" ? item.custom_id : "unknown"}${typeof item.title === "string" && item.title ? ` ${item.title}` : ""}`,
			);
		return lines.join("\n");
	}
	if (record && "items" in record && Array.isArray(record.items)) {
		const firstItem = record.items[0];
		if (typeof firstItem === "object" && firstItem !== null && "id" in firstItem && "properties" in firstItem) {
			const r = record as { items: OrgItem[]; total: number };
			return formatOrgQueryResult(r.items, r.total ?? r.items.length);
		}
	}
	if (record && "fileContent" in record && typeof record.fileContent === "string") return record.fileContent;
	if (record && "item" in record && typeof record.item === "object" && record.item !== null)
		return renderItemOrg(record.item as OrgItem, true, Infinity);
	if (record && "success" in record) {
		const parts: string[] = [];
		if (record.success) parts.push("success");
		if (record.id) parts.push(`id: ${record.id}`);
		if (Array.isArray(record.updated)) parts.push(`updated: ${(record.updated as string[]).join(", ")}`);
		if (typeof record.file === "string") parts.push(`file: ${record.file}`);
		if (typeof record.section === "string") parts.push(`section: ${record.section}`);
		if (typeof record.state === "string") parts.push(`state: ${record.state}`);
		if (typeof record.category === "string") parts.push(`category: ${record.category}`);
		return parts.join("\n");
	}
	if (record && "error" in record)
		return `error: ${record.message ?? "unknown"}${record.code ? ` (${record.code})` : ""}`;
	return JSON.stringify(result, null, 2);
}
