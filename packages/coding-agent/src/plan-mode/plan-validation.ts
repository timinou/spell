import { extractIdLinks } from "@oh-my-pi/pi-org";
import type { Settings } from "../config/settings";
import { buildDependencyGraph, parseOrgDependProperties } from "../loop/ingestion/org-depend";
import { resolvePlanItem } from "./org-plan";

export interface PlanValidationIssue {
	category: string;
	items: string[];
	message: string;
}

export interface ResolvedPlanChildItem {
	id: string;
	file: string;
	body: string;
	properties: Record<string, string>;
}

export interface PlanValidationResult {
	valid: boolean;
	issues: PlanValidationIssue[];
	planItem: {
		id: string;
		file: string;
		body: string;
		properties: Record<string, string>;
	};
	childItemIds: string[];
	resolvedChildren: Map<string, ResolvedPlanChildItem>;
}

function createIssue(category: string, message: string, items: string[] = []): PlanValidationIssue {
	return { category, message, items };
}

function humanizeCategory(category: string): string {
	return category.replace(/-/g, " ");
}

function validateChildSuboutlineGraph(resolvedChildren: Map<string, ResolvedPlanChildItem>): PlanValidationIssue[] {
	const parsedByChildId = new Map<string, ReturnType<typeof parseOrgDependProperties>>();
	const missingStructuredBodies: string[] = [];
	const namespaceViolations: string[] = [];
	const duplicateSuboutlineIds: string[] = [];
	const brokenSuboutlineDeps: string[] = [];
	const allSuboutlines: ReturnType<typeof parseOrgDependProperties> = [];
	const ownerBySuboutlineId = new Map<string, string>();
	const suboutlineIdSet = new Set<string>();
	const normalizeSuboutlineId = (childItemId: string, candidate: string): string | null => {
		const expectedPrefix = `${childItemId}::`;
		if (candidate.startsWith(expectedPrefix)) {
			const suffix = candidate.slice(expectedPrefix.length);
			return /^[A-Za-z0-9_-]+$/.test(suffix) ? candidate : null;
		}
		if (!candidate.includes("::")) {
			return /^[A-Za-z0-9_-]+$/.test(candidate) ? `${childItemId}::${candidate}` : null;
		}
		const numericPrefix = childItemId.match(/^[A-Z]+-\d+/)?.[0] ?? null;
		const [left, suffix] = candidate.split("::", 2);
		if (!numericPrefix || left !== numericPrefix) return null;
		return /^[A-Za-z0-9_-]+$/.test(suffix) ? `${childItemId}::${suffix}` : null;
	};

	for (const [childItemId, childItem] of resolvedChildren) {
		const parsed = parseOrgDependProperties(childItem.body);
		if (parsed.length === 0) {
			parsedByChildId.set(childItemId, parsed);
			missingStructuredBodies.push(childItemId);
			continue;
		}

		const normalizedParsed = parsed.flatMap(suboutline => {
			const normalizedCustomId = normalizeSuboutlineId(childItemId, suboutline.customId);
			if (!normalizedCustomId) {
				namespaceViolations.push(
					`${childItemId} sub-outline CUSTOM_ID must match ${childItemId}::suboutline-id (got ${suboutline.customId})`,
				);
				return [];
			}
			const normalizedSuboutline = {
				...suboutline,
				customId: normalizedCustomId,
				blockers: suboutline.blockers.map(depId => normalizeSuboutlineId(childItemId, depId) ?? depId),
			};
			allSuboutlines.push(normalizedSuboutline);
			const existingOwner = ownerBySuboutlineId.get(normalizedCustomId);
			if (existingOwner) {
				duplicateSuboutlineIds.push(`${normalizedCustomId} declared in both ${existingOwner} and ${childItemId}`);
				return [normalizedSuboutline];
			}
			ownerBySuboutlineId.set(normalizedCustomId, childItemId);
			suboutlineIdSet.add(normalizedCustomId);
			return [normalizedSuboutline];
		});
		parsedByChildId.set(childItemId, normalizedParsed);
	}

	const issues: PlanValidationIssue[] = [];
	if (missingStructuredBodies.length > 0) {
		issues.push(
			createIssue(
				"missing-suboutline-steps",
				"Add structured implementation sub-headings with :CUSTOM_ID: FILE-LEVEL-ID::suboutline-id properties before exiting.",
				missingStructuredBodies,
			),
		);
	}
	if (namespaceViolations.length > 0) {
		issues.push(
			createIssue(
				"invalid-suboutline-namespace",
				"Sub-outline CUSTOM_ID values must stay within the owning child item's namespace.",
				namespaceViolations,
			),
		);
	}
	if (duplicateSuboutlineIds.length > 0) {
		issues.push(
			createIssue(
				"duplicate-suboutline-id",
				"Every sub-outline CUSTOM_ID must be globally unique within the plan.",
				duplicateSuboutlineIds,
			),
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
		issues.push(
			createIssue(
				"broken-suboutline-depends",
				"All sub-outline :DEPENDS: values must reference declared sub-outline CUSTOM_IDs in linked child items.",
				brokenSuboutlineDeps,
			),
		);
	}

	const graph = buildDependencyGraph(allSuboutlines);
	if (graph.cycles.length > 0) {
		issues.push(
			createIssue(
				"cyclic-suboutline-depends",
				"Sub-outline :DEPENDS: graphs must be acyclic.",
				graph.cycles.map(cycle => cycle.join(" -> ")),
			),
		);
	}

	return issues;
}

export async function validatePlanItem(
	settings: Settings,
	projectRoot: string,
	planItemId: string,
): Promise<PlanValidationResult | null> {
	const planItem = await resolvePlanItem(settings, projectRoot, planItemId);
	if (!planItem) return null;

	const childItemIds = extractIdLinks(planItem.body);
	const resolvedChildren = new Map<string, ResolvedPlanChildItem>();
	const issues: PlanValidationIssue[] = [];

	if (childItemIds.length === 0) {
		issues.push(
			createIssue(
				"missing-child-links",
				`PLAN item "${planItemId}" must include at least one child reference using [[id:...]] links in its body.`,
			),
		);
	}

	const missingChildIds: string[] = [];
	for (const childItemId of childItemIds) {
		const childItem = await resolvePlanItem(settings, projectRoot, childItemId);
		if (!childItem) {
			missingChildIds.push(childItemId);
			continue;
		}
		resolvedChildren.set(childItemId, childItem);
	}
	if (missingChildIds.length > 0) {
		issues.push(
			createIssue(
				"missing-linked-items",
				"Create the missing child items or fix the PLAN body's [[id:...]] links before exiting.",
				missingChildIds,
			),
		);
	}

	const thinChildIds: string[] = [];
	const missingProps: string[] = [];
	const childIdSet = new Set(childItemIds);
	const brokenDeps: string[] = [];
	for (const [childItemId, childItem] of resolvedChildren) {
		if (!childItem.body || childItem.body.trim().length < 100) {
			thinChildIds.push(childItemId);
		}

		const missing: string[] = [];

		if (!childItem.properties.LAYER) missing.push("LAYER");
		if (missing.length > 0) {
			missingProps.push(`${childItemId} missing: ${missing.join(", ")}`);
		}

		const depends = childItem.properties.DEPENDS;
		if (!depends) continue;
		for (const depId of depends.split(/\s+/).filter(Boolean)) {
			if (!childIdSet.has(depId)) {
				brokenDeps.push(`${childItemId} depends on ${depId} which is not in this plan`);
			}
		}
	}

	if (thinChildIds.length > 0) {
		issues.push(
			createIssue(
				"thin-child-body",
				"These child items have empty or minimal bodies (< 100 chars) and are not self-contained for implementing agents. Add implementation details, design decisions, file paths, and acceptance criteria before exiting.",
				thinChildIds,
			),
		);
	}
	if (missingProps.length > 0) {
		issues.push(
			createIssue(
				"missing-child-properties",
				"Set LAYER on all child items before exiting. DEPENDS is recommended for dependency-linked items.",
				missingProps,
			),
		);
	}
	if (brokenDeps.length > 0) {
		issues.push(
			createIssue(
				"broken-child-depends",
				"All top-level DEPENDS values must reference items linked in this plan.",
				brokenDeps,
			),
		);
	}

	issues.push(...validateChildSuboutlineGraph(resolvedChildren));

	return {
		valid: issues.length === 0,
		issues,
		planItem,
		childItemIds,
		resolvedChildren,
	};
}

export function formatPlanValidationIssues(planItemId: string, issues: PlanValidationIssue[]): string {
	if (issues.length === 0) {
		return `PLAN item "${planItemId}" is valid.`;
	}

	const hintByCategory: Record<string, (items: string[]) => string | null> = {
		"invalid-suboutline-namespace": items => {
			const first = items[0];
			if (!first) return null;
			const match = /^(\S+) sub-outline CUSTOM_ID.*\(got (.+)\)$/.exec(first);
			if (!match) return "fix: rename CUSTOM_ID to <child-item-id>::<suboutline-id>";
			const [, childItemId, got] = match;
			const suffix = got.includes("::") ? got.split("::").slice(1).join("::") : got;
			if (!/^[A-Za-z0-9_-]+$/.test(suffix)) {
				return `fix: rename CUSTOM_ID to ${childItemId}::<suboutline-id> using only letters, digits, _ or -`;
			}
			return `fix: rename CUSTOM_ID to ${childItemId}::${suffix}`;
		},
		"broken-suboutline-depends": () =>
			"fix: update :DEPENDS: to declared sub-outline CUSTOM_IDs from linked child items.",
		"missing-suboutline-steps": items =>
			`fix: add structured sub-headings to ${items[0] ?? "each child item"} with :CUSTOM_ID: ${items[0] ?? "CHILD-ID"}::<slug>`,
		"missing-child-properties": () =>
			"fix: add LAYER to each child item before exiting; add DEPENDS when the item depends on other child items.",
		"broken-child-depends": () => "fix: change top-level DEPENDS values to linked child item CUSTOM_IDs only.",
	};

	const lines = [`PLAN item "${planItemId}" has ${issues.length} validation issue(s):`];
	for (const issue of issues) {
		lines.push("");
		lines.push(`${humanizeCategory(issue.category)}:`);
		lines.push(issue.message);
		for (const item of issue.items) {
			lines.push(`- ${item}`);
		}
		const hint = hintByCategory[issue.category]?.(issue.items);
		if (hint) lines.push(hint);
	}
	return lines.join("\n");
}
