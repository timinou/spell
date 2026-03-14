import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import { resolvePlanDraftItem } from "../plan-mode/org-plan";
import exitPlanModeDescription from "../prompts/tools/exit-plan-mode.md" with { type: "text" };
import type { ToolSession } from ".";
import { resolvePlanPath } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";

const exitPlanModeSchema = Type.Object({
	title: Type.String({ description: "Final plan name in SCREAMING_SNAKE_CASE, e.g. WP_MIGRATION_PLAN" }),
	itemId: Type.Optional(
		Type.String({
			description:
				"CUSTOM_ID of the org draft item you created via `org create` (e.g. DRAFT-003-auth-refactor). Required when org is enabled.",
		}),
	),
});

type ExitPlanModeParams = Static<typeof exitPlanModeSchema>;

function normalizePlanTitle(title: string): { title: string; fileName: string } {
	const trimmed = title.trim();
	if (!trimmed) {
		throw new ToolError("Title is required and must not be empty.");
	}
	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
		throw new ToolError("Title must not contain path separators or '..'.");
	}
	// Accept any extension; add .md only when none is present (backward compat for file-backed plans).
	// Org-backed plans (itemId provided) treat fileName as vestigial.
	const hasExtension = /\.[a-z]+$/i.test(trimmed);
	const fileName = hasExtension ? trimmed : `${trimmed}.md`;
	if (!/^[A-Za-z0-9_.-]+$/.test(fileName)) {
		throw new ToolError("Title may only contain letters, numbers, underscores, hyphens, or dots.");
	}
	const normalizedTitle = hasExtension ? trimmed.slice(0, trimmed.lastIndexOf(".")) : trimmed;
	return { title: normalizedTitle, fileName };
}

export interface ExitPlanModeDetails {
	planFilePath: string;
	planExists: boolean;
	title: string;
	finalPlanFilePath: string;
	/** CUSTOM_ID of the org item the agent created for the plan. */
	itemId?: string;
	/** Absolute path to the .org file containing the plan item. */
	orgItemFile?: string;
	/** Body text of the org item — used as plan content for display and finalization. */
	planContent?: string;
}

export class ExitPlanModeTool implements AgentTool<typeof exitPlanModeSchema, ExitPlanModeDetails> {
	readonly name = "exit_plan_mode";
	readonly label = "ExitPlanMode";
	readonly description: string;
	readonly parameters = exitPlanModeSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = renderPromptTemplate(exitPlanModeDescription);
	}

	async execute(
		_toolCallId: string,
		params: ExitPlanModeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ExitPlanModeDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ExitPlanModeDetails>> {
		const state = this.session.getPlanModeState?.();
		if (!state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}

		const normalized = normalizePlanTitle(params.title);
		const finalPlanFilePath = `local://${normalized.fileName}`;
		const resolvedPlanPath = resolvePlanPath(this.session, state.planFilePath);
		resolvePlanPath(this.session, finalPlanFilePath);

		// Org-backed plan: resolve item and return its body as the plan content.
		if (params.itemId) {
			const item = await resolvePlanDraftItem(this.session.settings, this.session.cwd, params.itemId);
			if (!item) {
				throw new ToolError(
					`Org item "${params.itemId}" not found. Make sure you created it via \`org create\` before calling this tool.`,
				);
			}
			return {
				content: [{ type: "text", text: "Plan ready for approval." }],
				details: {
					planFilePath: state.planFilePath,
					planExists: true,
					title: normalized.title,
					finalPlanFilePath,
					itemId: params.itemId,
					orgItemFile: item.file,
					planContent: item.body,
				},
			};
		}

		// File-backed plan (fallback / org disabled): read from plan file.
		let planExists = false;
		try {
			const stat = await fs.stat(resolvedPlanPath);
			planExists = stat.isFile();
		} catch (error) {
			if (!isEnoent(error)) {
				throw error;
			}
		}

		return {
			content: [{ type: "text", text: "Plan ready for approval." }],
			details: {
				planFilePath: state.planFilePath,
				planExists,
				title: normalized.title,
				finalPlanFilePath,
			},
		};
	}
}
