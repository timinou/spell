import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@spell/pi-agent-core";
import { isEnoent } from "@spell/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import { resolveLayerFromProperties } from "../config/task-policies";
import type { PlanWave } from "../orchestrators/fluid";
import { buildChildItemSpecs, type ChildItemSpec } from "../plan-mode/child-item-spec";
import { resolvePlanItem } from "../plan-mode/org-plan";
import { formatPlanValidationIssues, validatePlanItem } from "../plan-mode/plan-validation";
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
	itemId?: string;
	orgItemFile?: string;
	planContent?: string;
	childItemIds?: string[];
	childItems?: ChildItemSpec[];
	childItemsOmittedCount?: number;
	waves?: PlanWave[];
}

/**
 * Extract wave structure from the plan body's Execution Manifest.
 *
 * Looks for `** wave-name :wave:` headings followed by `- [[id:...]] description` entries.
 * Returns undefined if no wave headings are found (backward compat with flat manifests).
 */
export function extractPlanWaves(body: string): PlanWave[] | undefined {
	const waveRe = /^\s*\*\*\s+(.+?)\s+:wave:\s*$/;
	const subheadingRe = /^\s*\*\*\s+/;
	const entryRe = /^\s*-\s+\[\[id:([^\]]+)\](?:\[[^\]]*\])?\]\s+(.+)$/;
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
		if (subheadingRe.test(line)) {
			current = null;
			continue;
		}
		if (!current) {
			continue;
		}
		const entryMatch = entryRe.exec(line);
		if (!entryMatch) {
			continue;
		}
		const orgItemId = entryMatch[1];
		current.entries.push({
			id: orgItemId,
			orgItemId,
			step: entryMatch[2],
		});
	}

	return waves.length > 0 ? waves : undefined;
}

export class ExitPlanModeTool implements AgentTool<typeof exitPlanModeSchema, ExitPlanModeDetails> {
	readonly name = "exit_plan_mode";
	readonly label = "ExitPlanMode";
	readonly description: string;
	readonly parameters = exitPlanModeSchema;
	readonly strict = true;
	// Swaps the session mode and tool set; subsequent tool calls in the batch
	// would otherwise execute under an inconsistent tool registry. Sequential
	// pins this to a clean before/after boundary.
	readonly executionMode = "sequential" as const;

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
		const normalized = normalizePlanTitle(params.title);
		const finalPlanFilePath = `local://${normalized.fileName}`;
		if (!state?.enabled) {
			const lastApprovedPlan = this.session.getLastApprovedPlan?.();
			if (
				lastApprovedPlan &&
				lastApprovedPlan.itemId === params.itemId &&
				lastApprovedPlan.finalPlanFilePath === finalPlanFilePath
			) {
    return {
    				content: [{ type: "text", text: "Plan already approved." }],
    				details: {
    					planFilePath: lastApprovedPlan.finalPlanFilePath,
    					planExists: true,
    					title: lastApprovedPlan.title,
    					finalPlanFilePath: lastApprovedPlan.finalPlanFilePath,
    					itemId: lastApprovedPlan.itemId,
    				},
    				data: null,
    			};
			}
			throw new ToolError("Plan mode is not active.");
		}
		const resolvedPlanPath = resolvePlanPath(this.session, state.planFilePath);
		resolvePlanPath(this.session, finalPlanFilePath);
		const orgEnabled = (this.session.settings.get("org.enabled") as boolean | undefined) ?? false;
		if (orgEnabled && !params.itemId) {
			throw new ToolError("itemId is required when org is enabled. Provide the PLAN item's CUSTOM_ID.");
		}

		if (params.itemId) {
			const validation = await validatePlanItem(this.session.settings, this.session.cwd, params.itemId);
			if (!validation) {
				throw new ToolError(
					`Org PLAN item "${params.itemId}" not found. Make sure you created it via \`org create\` before calling this tool.`,
				);
			}
			if (!validation.valid) {
				throw new ToolError(formatPlanValidationIssues(params.itemId, validation.issues));
			}

			const item = validation.planItem;
			const childItemIds = validation.childItemIds;
			const childItemSpecs = buildChildItemSpecs(validation.resolvedChildren, validation.childItemIds, {
				perChildMaxBytes: this.session.settings.get("plan.injectedChildItemMaxBytes") as number,
				globalMaxBytes: this.session.settings.get("plan.approvedPromptMaxBytes") as number,
			});
			const waves = extractPlanWaves(item.body);
			if (waves) {
				const propertiesByItemId = new Map<string, Record<string, string>>(
					Array.from(validation.resolvedChildren, ([id, child]) => [id, child.properties]),
				);
				const loadProperties = async (itemId: string): Promise<Record<string, string> | undefined> => {
					const cached = propertiesByItemId.get(itemId);
					if (cached) return cached;

					const resolved = await resolvePlanItem(this.session.settings, this.session.cwd, itemId);
					const properties = resolved?.properties;
					if (properties) {
						propertiesByItemId.set(itemId, properties);
					}
					return properties;
				};

				for (const wave of waves) {
					for (const entry of wave.entries) {
						if (!entry.orgItemId) continue;
						await loadProperties(entry.orgItemId);
						const separatorIndex = entry.orgItemId.indexOf("::");
						if (separatorIndex !== -1) {
							await loadProperties(entry.orgItemId.slice(0, separatorIndex));
						}
						entry.layer = resolveLayerFromProperties(entry.orgItemId, itemId => propertiesByItemId.get(itemId));
					}
				}
			}
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
   				childItems: childItemSpecs.items,
   				childItemsOmittedCount: childItemSpecs.omittedCount,
   				waves,
   			},
   			data: null,
   		};
		}

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
  			data: null,
  		};
	}
}
