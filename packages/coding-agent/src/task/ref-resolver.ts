/**
 * Resolve a task `ref` to its linkage kind.
 *
 * `ref` replaces the legacy `todoRef`. It is a required field whose value may be:
 * - `null`              — no linkage (explicit, valid)
 * - roster id (`task-N`) — links to an in-session todo roster item
 * - `org://ITEM-ID`     — links to a durable org item (cross-session)
 *
 * The resolver dispatches on shape so call sites can branch without
 * re-parsing the raw string. Roster refs preserve the historical
 * `todoRef` behaviour exactly; org refs unlock durable linkage.
 */

import { findItemById, resolveCategories } from "@spell/pi-org";
import type { Settings } from "../config/settings";
import { buildOrgConfig } from "../org/org-plan";

/** Discriminated linkage kind parsed from a task `ref`. */
export type RefKind = { kind: "none" } | { kind: "roster"; id: string } | { kind: "org"; uri: string; itemId: string };

const ORG_URI_PREFIX = "org://";

/**
 * Parse a raw `ref` value into its discriminated kind. Pure/synchronous —
 * no I/O. `org://` resolution to an actual item happens in
 * {@link resolveOrgRefItem}.
 */
export function resolveRef(ref: string | null | undefined): RefKind {
	if (ref === null || ref === undefined) return { kind: "none" };
	const trimmed = ref.trim();
	if (trimmed === "") return { kind: "none" };
	if (trimmed.startsWith(ORG_URI_PREFIX)) {
		const itemId = trimmed.slice(ORG_URI_PREFIX.length).replace(/\/+$/u, "");
		if (itemId === "") return { kind: "none" };
		return { kind: "org", uri: trimmed, itemId };
	}
	return { kind: "roster", id: trimmed };
}

/** Verification + assignment material derived from an org item. */
/** Runtime-enforceable gate subset derived from org PROPERTIES.
 *  Structurally compatible with executor's RuntimeVerificationOptions (sans baseline). */
export interface OrgGateOptions {
	gateCmd?: string;
	gateCommit?: boolean;
	gateArtifact?: string;
}

/** Verification + assignment material derived from an org item. */
export interface OrgRefResolution {
	itemId: string;
	title: string;
	state: string;
	/** Body text — used as assignment fallback when no explicit assignment given. */
	body: string;
	/** Verification requirement lines mapped from PROPERTIES drawer (human-readable, incl. advisory). */
	verificationLines: string[];
	/** Runtime-enforceable gate subset mapped from PROPERTIES drawer (what the executor actually checks). */
	gateOptions: OrgGateOptions;
}

/**
 * Map known PROPERTIES-drawer keys to verification requirement lines.
 *
 * Org items carry gate intent in their PROPERTIES drawer. This mirrors the
 * full roster `resolveVerificationContext` gate set so an `org://` ref injects
 * the same requirements a roster ref would. Recognised keys (UPPER or
 * lower_snake spelling):
 * - GATE_CMD               → MUST run command
 * - GATE_ARTIFACT          → MUST produce artifact
 * - VERIFICATION_ARTIFACT  → evidence persistence note
 * - GATE_COMMIT            → MUST commit (string; false|0|no|off ⇒ off)
 * - GATE_LLM               → MUST self-review against criteria
 * - VERIFY_CMD             → SHOULD run command
 * - ORG_ITEM_CLOSING_ID    → MUST update the closing org item
 */
export function mapOrgGateProperties(properties: Record<string, string>): string[] {
	const lines: string[] = [];
	const get = (upper: string, lower: string): string | undefined => properties[upper] ?? properties[lower];
	// Org PROPERTIES values are strings; treat these spellings as "off" for boolean gates.
	const isFalsy = (value: string): boolean => /^(false|0|no|off)$/iu.test(value.trim());
	const gateCmd = get("GATE_CMD", "gate_cmd");
	const gateArtifact = get("GATE_ARTIFACT", "gate_artifact");
	const verificationArtifact = get("VERIFICATION_ARTIFACT", "verification_artifact");
	const gateCommit = get("GATE_COMMIT", "gate_commit");
	const gateLlm = get("GATE_LLM", "gate_llm");
	const verifyCmd = get("VERIFY_CMD", "verify_cmd");
	const orgItemClosingId = get("ORG_ITEM_CLOSING_ID", "org_item_closing_id");
	if (gateCmd) lines.push(`You MUST run: \`${gateCmd}\` and verify it passes.`);
	if (gateArtifact) lines.push(`You MUST produce artifact at: ${gateArtifact}`);
	if (verificationArtifact) lines.push(`Verification evidence will be persisted at: ${verificationArtifact}`);
	if (gateCommit && !isFalsy(gateCommit)) lines.push("You MUST commit changes before yielding.");
	if (gateLlm) lines.push(`You MUST self-review against: ${gateLlm}`);
	if (verifyCmd) lines.push(`You SHOULD run: \`${verifyCmd}\` to verify.`);
	if (orgItemClosingId) {
		lines.push(
			`You MUST update org item ${orgItemClosingId}: set to DOING at start, update with progress, and append completion report when done.`,
		);
	}
	return lines;
}
/**
 * Map the runtime-ENFORCEABLE gate subset from an org PROPERTIES drawer.
 *
 * This is the structured counterpart to {@link mapOrgGateProperties}: where that
 * produces human-readable MUST/SHOULD lines for the assignment, this produces the
 * machine-checkable options the executor's `verifyGates` actually runs on
 * submit_result. Only the three enforceable gates map here (GATE_CMD / GATE_ARTIFACT
 * / GATE_COMMIT); advisory keys (VERIFY_CMD, GATE_LLM, …) stay text-only.
 *
 * Mirrors the roster path, where `todo.verify.{cmd,artifact,commit}` feed
 * RuntimeVerificationOptions — closing the org-vs-roster enforcement asymmetry.
 */
export function mapOrgGateOptions(properties: Record<string, string>): OrgGateOptions {
	const get = (upper: string, lower: string): string | undefined => properties[upper] ?? properties[lower];
	const isFalsy = (value: string): boolean => /^(false|0|no|off)$/iu.test(value.trim());
	const gateCmd = get("GATE_CMD", "gate_cmd");
	const gateArtifact = get("GATE_ARTIFACT", "gate_artifact");
	const gateCommit = get("GATE_COMMIT", "gate_commit");
	const options: OrgGateOptions = {};
	if (gateCmd) options.gateCmd = gateCmd;
	if (gateArtifact) options.gateArtifact = gateArtifact;
	if (gateCommit && !isFalsy(gateCommit)) options.gateCommit = true;
	return options;
}
/**
 * Resolve an `org://` ref to its item content + verification material.
 * Returns undefined when org is disabled or the item is not found.
 */
export async function resolveOrgRefItem(
	itemId: string,
	settings: Settings,
	cwd: string,
): Promise<OrgRefResolution | undefined> {
	if (!settings.get("org.enabled")) return undefined;
	const config = buildOrgConfig(settings);
	const categories = resolveCategories(config, cwd);
	const catDirs = categories.map(c => ({
		absPath: c.absPath,
		name: c.name,
		dir: c.dirName,
		prefix: c.prefix,
		root: cwd,
	}));
	const item = await findItemById(catDirs, itemId, config.todoKeywords);
	if (!item) return undefined;
	return {
		itemId,
		title: item.title ?? itemId,
		state: item.state,
		body: item.body ?? "",
		verificationLines: mapOrgGateProperties(item.properties ?? {}),
		gateOptions: mapOrgGateOptions(item.properties ?? {}),
	};
}

/**
 * Build a verification requirements block from an org ref resolution.
 * Mirrors the roster-side `resolveVerificationContext` output shape.
 */
export function buildOrgVerificationContext(resolution: OrgRefResolution): string | undefined {
	if (resolution.verificationLines.length === 0) return undefined;
	return `--- Verification Requirements (from org://${resolution.itemId}) ---\n${resolution.verificationLines.join("\n")}`;
}

/**
 * Build a sniper-style assignment from an org ref resolution, used when a
 * task references an org item but provides no explicit assignment.
 */
export function buildOrgAssignment(resolution: OrgRefResolution): string | undefined {
	const trimmedBody = resolution.body.trim();
	const parts: string[] = [`## Task: ${resolution.title}`];
	if (trimmedBody) {
		parts.push("");
		parts.push(trimmedBody);
	}
	return parts.length > 1 ? parts.join("\n") : `## Task: ${resolution.title}`;
}
