/**
 * Read per-verb runtime-tool gate policy from spell.kdl (PLAN-337 Phase 2.5).
 *
 * The per-verb gate is dynamic (tool→verb→gate), so it does not fit the flat
 * settings schema; it is read directly from the KDL document. Shape:
 *
 *   runtime-tools {
 *     git {
 *       verb "reset"    gate="warn"
 *       verb "checkout" gate="warn"
 *     }
 *     run { verb "exec" gate="silent" }
 *   }
 *
 * Three tiers are merged (user < project < local; later wins per verb), then the
 * result is handed to the loader as each tool's `RawToolPolicy`. The loader's
 * `resolvePolicy` validates it against the interface (phantom-verb errors) and
 * fills any unspecified verb from its `:class` default \u2014 so a user only writes
 * the gates they want to change.
 */
import type { Document } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import { getLocalKdlPath, getProjectKdlPath, getUserKdlPath, isEnoent, logger } from "@spell/pi-utils";
import { getChildNodes, getDocumentNode, getStringArgument, getStringProperty } from "../../config/kdl-helpers";
import type { RawToolPolicy } from "./policy";

/** All tools' policies parsed from one KDL document's `runtime-tools` block. */
function readRuntimeToolsBlock(doc: Document): Record<string, RawToolPolicy> {
	const out: Record<string, RawToolPolicy> = {};
	const block = getDocumentNode(doc, "runtime-tools");
	if (!block) return out;

	// Each child node of `runtime-tools` is a tool (git, run, ...).
	for (const toolNode of getChildNodes(block)) {
		const toolName = toolNode.getName();
		const policy: RawToolPolicy = {};
		// Each `verb "<name>" gate="<gate>"` child sets one verb's gate.
		for (const verbNode of getChildNodes(toolNode, "verb")) {
			const verbName = getStringArgument(verbNode);
			const gate = getStringProperty(verbNode, "gate");
			if (verbName && gate) policy[verbName] = { gate };
		}
		if (Object.keys(policy).length > 0) out[toolName] = policy;
	}
	return out;
}

/** Parse one KDL file's runtime-tool policies; empty on missing/invalid file. */
async function readTier(filePath: string): Promise<Record<string, RawToolPolicy>> {
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return {};
		throw err;
	}
	try {
		return readRuntimeToolsBlock(parse(content));
	} catch (err) {
		logger.warn("runtime-tools: failed to parse spell.kdl runtime-tools block", { filePath, error: String(err) });
		return {};
	}
}

/** Merge per-tool, per-verb (b wins) so higher tiers override lower ones. */
function mergePolicies(
	a: Record<string, RawToolPolicy>,
	b: Record<string, RawToolPolicy>,
): Record<string, RawToolPolicy> {
	const out: Record<string, RawToolPolicy> = {};
	for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
		out[name] = { ...(a[name] ?? {}), ...(b[name] ?? {}) };
	}
	return out;
}

/**
 * Read merged runtime-tool gate policies from the spell.kdl tiers
 * (user < project < local). Returns `toolName \u2192 RawToolPolicy`.
 */
export async function readRuntimeToolPolicies(cwd: string): Promise<Record<string, RawToolPolicy>> {
	const [user, project, local] = await Promise.all([
		readTier(getUserKdlPath()),
		readTier(getProjectKdlPath(cwd)),
		readTier(getLocalKdlPath(cwd)),
	]);
	return mergePolicies(mergePolicies(user, project), local);
}
