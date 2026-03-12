/**
 * Org tool adapter — wraps the @oh-my-pi/pi-org tool for use in coding-agent.
 *
 * Reads org config from settings + project-local .spell/config.yml, resolves
 * categories relative to the project root, and optionally starts an Emacs
 * daemon for advanced operations.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { EmacsSession, OrgConfig, OrgSessionContext } from "@oh-my-pi/pi-org";
import { createOrgTool, DEFAULT_ORG_CONFIG, detectEmacs, startEmacsSession } from "@oh-my-pi/pi-org";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSession } from ".";

// Path to the elisp directory shipped with the pi-org package.
// import.meta.dir = packages/coding-agent/src/tools — navigate to workspace root then pi-org
const ELISP_DIR = new URL("../../../org/elisp", import.meta.url).pathname;

// =============================================================================
// Schema
// =============================================================================

const orgSchema = Type.Object({
	command: Type.String({
		description:
			"Subcommand: init | create | query | get | update | set | validate | dashboard | wave | graph | archive",
	}),
	// create params
	title: Type.Optional(Type.String({ description: "Item title (for create)" })),
	category: Type.Optional(Type.String({ description: "Category name or prefix" })),
	state: Type.Optional(Type.String({ description: "TODO state" })),
	properties: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Properties map" })),
	body: Type.Optional(Type.String({ description: "Item body text" })),
	file: Type.Optional(Type.String({ description: "Target file basename (optional)" })),
	// query params
	dir: Type.Optional(Type.String({ description: "Org dir filter" })),
	priority: Type.Optional(Type.String({ description: "Priority filter (#A/#B/#C)" })),
	layer: Type.Optional(Type.String({ description: "Layer filter" })),
	agent: Type.Optional(Type.String({ description: "Agent filter" })),
	includeBody: Type.Optional(Type.Boolean({ description: "Include body text in query results" })),
	// get/update/set params
	id: Type.Optional(Type.String({ description: "Task CUSTOM_ID" })),
	note: Type.Optional(Type.String({ description: "Note to append on state change" })),
	property: Type.Optional(Type.String({ description: "Property name (for set)" })),
	value: Type.Optional(Type.String({ description: "Property value (for set)" })),
});

type OrgParams = Static<typeof orgSchema>;

// =============================================================================
// Tool class
// =============================================================================

export class OrgTool implements AgentTool<typeof orgSchema> {
	readonly name = "org";
	readonly label = "Org";
	readonly description: string;
	readonly parameters = orgSchema;
	readonly lenientArgValidation = true;

	#inner: ReturnType<typeof createOrgTool>;

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
			const text = JSON.stringify(result, null, 2);
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
		return new Text(text.slice(0, 500), 0, 0);
	}
}

// =============================================================================
// Helpers
// =============================================================================

function makeEmacsFactory(
	emacsPath: string | undefined,
	projectRoot: string,
	sessionId: string,
): () => Promise<EmacsSession | null> {
	return async () => {
		const detection = await detectEmacs(emacsPath);
		if (!detection.found || !detection.meetsMinimum || !detection.socatFound) {
			if (detection.errors.length > 0) {
				logger.debug("org: Emacs not available", { errors: detection.errors });
			}
			return null;
		}
		try {
			return await startEmacsSession(detection.path!, projectRoot, sessionId, ELISP_DIR);
		} catch (err) {
			logger.warn("org: Failed to start Emacs session", { error: String(err) });
			return null;
		}
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
