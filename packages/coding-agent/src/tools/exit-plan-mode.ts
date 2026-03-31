import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { extractIdLinks, type FluidPlanWithComponents } from "@oh-my-pi/pi-org";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import { resolvePlanItem } from "../plan-mode/org-plan";
import exitPlanModeDescription from "../prompts/tools/exit-plan-mode.md" with { type: "text" };
import type { ToolSession } from ".";
import { resolvePlanPath } from "./mode-guard";
import { ToolError } from "./tool-errors";

const exitPlanModeSchema = Type.Object({
	title: Type.String({ description: "Final plan name in SCREAMING_SNAKE_CASE, e.g. WP_MIGRATION_PLAN" }),
	itemId: Type.Optional(
		Type.String({
			description:
				"CUSTOM_ID of the PLAN item you created via `org create` (e.g. PLAN-003-auth-refactor). Required when org is enabled.",
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

export interface PlanWaveEntry {
	/** Sub-outline CUSTOM_ID (e.g., FEAT-001::define-types). */
	orgItemId: string;
	/** Description of the step. */
	step: string;
}

export interface PlanWave {
	/** Wave name (e.g., "foundation", "core"). */
	name: string;
	/** Entries in this wave — parallelizable. */
	entries: PlanWaveEntry[];
}

export interface ExitPlanModeDetails {
	planFilePath: string;
	planExists: boolean;
	title: string;
	finalPlanFilePath: string;
	/** CUSTOM_ID of the org PLAN item the agent created. */
	itemId?: string;
	/** Absolute path to the .org file containing the PLAN item. */
	orgItemFile?: string;
	/** Body text of the PLAN item — used as plan content for display and finalization. */
	planContent?: string;
	/** Child CUSTOM_ID references extracted from [[id:...]] links in PLAN body. */
	childItemIds?: string[];
	/** Wave structure extracted from Execution Manifest. */
	waves?: PlanWave[];
	/** FluidPlan with connected components from org-fluid-plan MCP tool. */
	fluidPlan?: FluidPlanWithComponents;
}

/**
 * Extract wave structure from plan body's Execution Manifest.
 *
 * Looks for `** wave-name :wave:` headings followed by `- [[id:...]] description` entries.
 * Returns undefined if no wave headings are found (backward compat with flat manifests).
 */
export function extractPlanWaves(body: string): PlanWave[] | undefined {
	const waveRe = /^\*\*\s+(.+?)\s+:wave:\s*$/;
	const entryRe = /^-\s+\[\[id:([^\]]+)\]\]\s+(.+)$/;
	const lines = body.split("\n");
	const waves: PlanWave[] = [];
	let current: PlanWave | null = null;

	for (const line of lines) {
		const waveMatch = waveRe.exec(line);
		if (waveMatch) {
			current = { name: waveMatch[1].trim(), entries: [] };
			waves.push(current);
			continue;
		}
		if (current) {
			const entryMatch = entryRe.exec(line);
			if (entryMatch) {
				current.entries.push({ orgItemId: entryMatch[1], step: entryMatch[2] });
			}
		}
	}

	return waves.length > 0 ? waves : undefined;
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
		const orgEnabled = (this.session.settings.get("org.enabled") as boolean | undefined) ?? false;
		if (orgEnabled && !params.itemId) {
			throw new ToolError("itemId is required when org is enabled. Provide the PLAN item's CUSTOM_ID.");
		}

		// Org-backed plan: resolve PLAN item, validate child references, and return its body as plan content.
		if (params.itemId) {
			const item = await resolvePlanItem(this.session.settings, this.session.cwd, params.itemId);
			if (!item) {
				throw new ToolError(
					`Org PLAN item "${params.itemId}" not found. Make sure you created it via \`org create\` before calling this tool.`,
				);
			}

			const childItemIds = extractIdLinks(item.body);
			if (childItemIds.length === 0) {
				throw new ToolError(
					`PLAN item "${params.itemId}" must include at least one child reference using [[id:...]] links in its body.`,
				);
			}

			const missingChildIds: string[] = [];
			for (const childItemId of childItemIds) {
				const childItem = await resolvePlanItem(this.session.settings, this.session.cwd, childItemId);
				if (!childItem) {
					missingChildIds.push(childItemId);
				}
			}
			if (missingChildIds.length > 0) {
				throw new ToolError(
					`PLAN item "${params.itemId}" references missing child items: ${missingChildIds.join(", ")}.`,
				);
			}
			const waves = extractPlanWaves(item.body);

			return {
				content: [
					{
						type: "text",
						text: `Plan ready for approval (${childItemIds.length} linked child items${waves ? `, ${waves.length} waves` : ""}).`,
					},
				],
				details: {
					planFilePath: state.planFilePath,
					planExists: true,
					title: normalized.title,
					finalPlanFilePath,
					itemId: params.itemId,
					orgItemFile: item.file,
					planContent: item.body,
					childItemIds,
					waves,
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

		if (!planExists) {
			throw new ToolError(
				`Plan file not found at ${state.planFilePath}. Write the finalized plan to ${state.planFilePath} before calling exit_plan_mode.`,
			);
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
