import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { extractIdLinks } from "@oh-my-pi/pi-org";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import { resolveLayerFromProperties } from "../config/task-policies";
import { buildDependencyGraph, parseOrgDependProperties } from "../loop/ingestion/org-depend";
import type { PlanWave } from "../orchestrators/fluid";
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

type ResolvedChildItem = {
	id: string;
	file: string;
	body: string;
	properties: Record<string, string>;
};

function validateChildSuboutlineGraph(resolvedChildren: Map<string, ResolvedChildItem>): void {
	const parsedByChildId = new Map<string, ReturnType<typeof parseOrgDependProperties>>();
	const missingStructuredBodies: string[] = [];
	const namespaceViolations: string[] = [];
	const duplicateSuboutlineIds: string[] = [];
	const brokenSuboutlineDeps: string[] = [];
	const allSuboutlines: ReturnType<typeof parseOrgDependProperties> = [];
	const ownerBySuboutlineId = new Map<string, string>();
	const suboutlineIdSet = new Set<string>();

	for (const [childItemId, childItem] of resolvedChildren) {
		const parsed = parseOrgDependProperties(childItem.body);
		parsedByChildId.set(childItemId, parsed);
		if (parsed.length === 0) {
			missingStructuredBodies.push(childItemId);
			continue;
		}

		for (const suboutline of parsed) {
			allSuboutlines.push(suboutline);
			const expectedPrefix = `${childItemId}::`;
			const suffix = suboutline.customId.startsWith(expectedPrefix)
				? suboutline.customId.slice(expectedPrefix.length)
				: "";
			if (
				!suboutline.customId.startsWith(expectedPrefix) ||
				suffix.length === 0 ||
				!/^[A-Za-z0-9_-]+$/.test(suffix)
			) {
				namespaceViolations.push(
					`${childItemId} sub-outline CUSTOM_ID must match ${childItemId}::suboutline-id (got ${suboutline.customId})`,
				);
			}
			const existingOwner = ownerBySuboutlineId.get(suboutline.customId);
			if (existingOwner) {
				duplicateSuboutlineIds.push(`${suboutline.customId} declared in both ${existingOwner} and ${childItemId}`);
				continue;
			}
			ownerBySuboutlineId.set(suboutline.customId, childItemId);
			suboutlineIdSet.add(suboutline.customId);
		}
	}

	if (missingStructuredBodies.length > 0) {
		throw new ToolError(
			`These child items are missing sub-outline steps with :CUSTOM_ID: FILE-LEVEL-ID::suboutline-id properties:\n${missingStructuredBodies.join("\n")}\nAdd structured implementation sub-headings before exiting.`,
		);
	}
	if (namespaceViolations.length > 0) {
		throw new ToolError(
			`Invalid sub-outline CUSTOM_ID values:\n${namespaceViolations.join("\n")}\nSub-outline CUSTOM_IDs must stay within the owning child item's namespace.`,
		);
	}
	if (duplicateSuboutlineIds.length > 0) {
		throw new ToolError(
			`Duplicate sub-outline CUSTOM_ID values:\n${duplicateSuboutlineIds.join("\n")}\nEvery sub-outline CUSTOM_ID must be globally unique.`,
		);
	}

	for (const parsed of parsedByChildId.values()) {
		for (const suboutline of parsed) {
			for (const depId of suboutline.blockers) {
				if (!suboutlineIdSet.has(depId)) {
					brokenSuboutlineDeps.push(
						`${suboutline.customId} depends on ${depId} which is not a declared sub-outline CUSTOM_ID in this plan`,
					);
				}
			}
		}
	}

	if (brokenSuboutlineDeps.length > 0) {
		throw new ToolError(
			`Broken sub-outline dependency references:\n${brokenSuboutlineDeps.join("\n")}\nAll sub-outline :DEPENDS: values must reference declared sub-outline CUSTOM_IDs in linked child items.`,
		);
	}

	const graph = buildDependencyGraph(allSuboutlines);
	if (graph.cycles.length > 0) {
		throw new ToolError(
			`Sub-outline dependency cycles:\n${graph.cycles.map(cycle => cycle.join(" -> ")).join("\n")}\nSub-outline :DEPENDS: graphs must be acyclic.`,
		);
	}
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

			const resolvedChildren = new Map<
				string,
				{ id: string; file: string; body: string; properties: Record<string, string> }
			>();
			const missingChildIds: string[] = [];
			for (const childItemId of childItemIds) {
				const childItem = await resolvePlanItem(this.session.settings, this.session.cwd, childItemId);
				if (!childItem) {
					missingChildIds.push(childItemId);
				} else {
					resolvedChildren.set(childItemId, childItem);
				}
			}
			if (missingChildIds.length > 0) {
				throw new ToolError(
					`PLAN item "${params.itemId}" references missing child items: ${missingChildIds.join(", ")}.`,
				);
			}

			// Validate child items have substantive bodies (min 100 chars)
			const thinChildIds: string[] = [];
			for (const [childItemId, childItem] of resolvedChildren) {
				if (!childItem.body || childItem.body.trim().length < 100) {
					thinChildIds.push(childItemId);
				}
			}
			if (thinChildIds.length > 0) {
				throw new ToolError(
					`These child items have empty or minimal bodies (< 100 chars) and are not self-contained for implementing agents: ${thinChildIds.join(", ")}. Add implementation details, design decisions, file paths, and acceptance criteria before exiting.`,
				);
			}

			// Validate child items have required properties
			const missingProps: string[] = [];
			for (const [childItemId, childItem] of resolvedChildren) {
				const missing: string[] = [];
				if (!childItem.properties.EFFORT) missing.push("EFFORT");
				if (!childItem.properties.PRIORITY) missing.push("PRIORITY");
				if (!childItem.properties.LAYER) missing.push("LAYER");
				if (missing.length > 0) {
					missingProps.push(`${childItemId} missing: ${missing.join(", ")}`);
				}
			}
			if (missingProps.length > 0) {
				throw new ToolError(
					`Child items with missing required properties:\n${missingProps.join("\n")}\nSet EFFORT, PRIORITY, and LAYER on all child items before exiting.`,
				);
			}
			// Validate top-level child item DEPENDS references stay within the linked child set
			const childIdSet = new Set(childItemIds);
			const brokenDeps: string[] = [];
			for (const [childItemId, childItem] of resolvedChildren) {
				const depends = childItem.properties.DEPENDS;
				if (!depends) continue;
				for (const depId of depends.split(/\s+/).filter(Boolean)) {
					if (!childIdSet.has(depId)) {
						brokenDeps.push(`${childItemId} depends on ${depId} which is not in this plan`);
					}
				}
			}
			if (brokenDeps.length > 0) {
				throw new ToolError(
					`Broken dependency references:\n${brokenDeps.join("\n")}\nAll DEPENDS must reference items linked in this plan.`,
				);
			}

			// Validate structured sub-outline CUSTOM_ID and :DEPENDS: graphs within linked child items
			validateChildSuboutlineGraph(resolvedChildren);

			const waves = extractPlanWaves(item.body);
			if (waves) {
				const propertiesByItemId = new Map<string, Record<string, string>>();
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
					waves,
				},
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
		};
	}
}
