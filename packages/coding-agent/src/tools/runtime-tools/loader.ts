/**
 * Loader for `deftool` runtime tools (PLAN-337).
 *
 * For each `<name>.ptc` interface file: compose it with the prelude, run
 * `(rt-describe)` in the BEAM to get its descriptor, then resolve the KDL
 * policy over that descriptor (validating both faces stay in lockstep). A tool
 * with policy errors is REJECTED (fail-loud) rather than loaded ungoverned.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@spell/pi-utils";
import { type EffectTag, registerRuntimeToolEffects } from "../ptc-runtime/effects";
import { type RawToolPolicy, resolvePolicy } from "./policy";
import { composeToolSource, type RuntimeToolDispatcher } from "./runtime";
import { classEffect, type LoadedRuntimeTool, type ToolDescriptor } from "./types";

export interface RuntimeToolSource {
	/** Absolute path to the `.ptc` interface file. */
	path: string;
	/** Parsed KDL policy block for this tool (verb → { gate }), if any. */
	policy?: RawToolPolicy;
	/**
	 * A precomputed descriptor. When present, the loader SKIPS the BEAM
	 * `describe` call — built-ins ship a static descriptor so loading them costs
	 * no runtime spawn (the dispatcher is only spawned lazily on the first verb
	 * call). A drift test asserts the embedded descriptor matches the .ptc.
	 */
	precomputedDescriptor?: ToolDescriptor;
}

export interface RuntimeToolLoadResult {
	tools: LoadedRuntimeTool[];
	errors: Array<{ path: string; error: string }>;
}

/** Load and validate a set of runtime-tool interface files. */
export async function loadRuntimeTools(
	sources: RuntimeToolSource[],
	dispatcher: RuntimeToolDispatcher,
	readSource?: (path: string) => string | undefined,
	kdlPolicies?: Record<string, RawToolPolicy>,
): Promise<RuntimeToolLoadResult> {
	const tools: LoadedRuntimeTool[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (const src of sources) {
		try {
			const interfaceSource = readSource?.(src.path) ?? (await fs.readFile(src.path, "utf8"));
			const source = composeToolSource(interfaceSource);

			// Built-ins ship a precomputed descriptor → no BEAM describe at load (the
			// dispatcher spawns lazily on first verb call). User .ptc files describe.
			const descriptor = src.precomputedDescriptor ?? (await dispatcher.describe(source));
			if (!descriptor?.name || typeof descriptor.verbs !== "object") {
				errors.push({ path: src.path, error: "interface did not produce a valid descriptor (missing name/verbs)" });
				continue;
			}

			// Merge KDL per-verb gates (by tool name) over the source's own policy —
			// KDL wins per verb (PLAN-337 Phase 2.5). Applies to built-ins AND user
			// .ptc uniformly, since the tool name is known after describe.
			const kdlPolicy = kdlPolicies?.[descriptor.name];
			const mergedPolicy: RawToolPolicy | undefined =
				src.policy || kdlPolicy ? { ...(src.policy ?? {}), ...(kdlPolicy ?? {}) } : undefined;
			const { policy, errors: policyErrors } = resolvePolicy(descriptor, mergedPolicy);
			if (policyErrors.length > 0) {
				// Fail-loud: a tool whose two faces disagree is not loaded.
				errors.push({ path: src.path, error: policyErrors.join("; ") });
				continue;
			}

			// Register this tool's per-verb effects (derived from each verb's :class)
			// so the execute coprocessor can call it under the default policy.
			const verbEffects = new Map<string, EffectTag>();
			for (const [verbName, verb] of Object.entries(descriptor.verbs)) {
				verbEffects.set(verbName, classEffect(verb.class));
			}
			registerRuntimeToolEffects(descriptor.name, verbEffects);

			tools.push({ descriptor, policy, source, path: src.path });
		} catch (e) {
			errors.push({ path: src.path, error: e instanceof Error ? e.message : String(e) });
		}
	}

	if (errors.length > 0) {
		for (const { path: p, error } of errors) {
			logger.warn(`runtime-tool load error (${path.basename(p)}): ${error}`);
		}
	}

	return { tools, errors };
}
