/**
 * KDL policy derivation + drift-proof validation for runtime tools (PLAN-337).
 *
 * Two faces of a tool definition stay in lockstep:
 *   - the `.ptc` INTERFACE declares verbs + their `:class`
 *   - the KDL block sets the BEHAVIOUR (per-verb `gate`)
 *
 * `deriveSkeleton` turns an interface into the KDL skeleton (each verb at its
 * class-default gate). `resolvePolicy` merges a parsed KDL block over the
 * interface and validates the pair:
 *   - a KDL verb that the interface does not declare → error (phantom policy)
 *   - a `:destructive` verb with no explicit gate    → error (ungoverned risk)
 * so neither face can silently drift from the other.
 */
import { defaultGate, type Gate, type ToolDescriptor, type ToolPolicy } from "./types";

const GATES: ReadonlySet<string> = new Set<Gate>(["silent", "warn", "confirm", "deny"]);

/** A parsed KDL `<tool> { verb "x" { gate "..." } }` block: verb → gate. */
export type RawToolPolicy = Record<string, { gate?: string }>;

export interface PolicyResolution {
	policy: ToolPolicy;
	errors: string[];
}

/**
 * Resolve the effective per-verb policy by merging a KDL block over the
 * interface descriptor, collecting any drift/validation errors.
 */
export function resolvePolicy(descriptor: ToolDescriptor, raw: RawToolPolicy | undefined): PolicyResolution {
	const errors: string[] = [];
	const verbs: Record<string, { gate: Gate }> = {};
	const rawEntries = raw ?? {};

	// Phantom-policy check: every KDL verb must exist in the interface.
	for (const verbName of Object.keys(rawEntries)) {
		if (!(verbName in descriptor.verbs)) {
			errors.push(
				`tool '${descriptor.name}': KDL policy names verb '${verbName}', which the interface does not declare`,
			);
		}
	}

	for (const [verbName, verb] of Object.entries(descriptor.verbs)) {
		const rawGate = rawEntries[verbName]?.gate;

		if (rawGate !== undefined && !GATES.has(rawGate)) {
			errors.push(
				`tool '${descriptor.name}': verb '${verbName}' has invalid gate '${rawGate}' ` +
					`(expected one of: silent, warn, confirm, deny)`,
			);
		}

		const gate: Gate = rawGate !== undefined && GATES.has(rawGate) ? (rawGate as Gate) : defaultGate(verb.class);

		// Ungoverned-risk check: a destructive verb must carry an EXPLICIT gate.
		// (Its default is `confirm`, but we require the policy to state it so the
		// risk is visible in config, never implicit.)
		if (verb.class === "destructive" && rawGate === undefined) {
			errors.push(
				`tool '${descriptor.name}': destructive verb '${verbName}' has no explicit gate in KDL ` +
					`(add \`verb "${verbName}" { gate "confirm" }\` — destructive verbs must be governed explicitly)`,
			);
		}

		verbs[verbName] = { gate };
	}

	return { policy: { verbs }, errors };
}

/**
 * Generate the KDL skeleton for a tool's interface: each verb at its
 * class-default gate. Used by `spell tools sync` to scaffold/refresh config
 * without clobbering existing user choices (the caller merges).
 */
export function deriveSkeleton(descriptor: ToolDescriptor): string {
	const lines: string[] = [`${descriptor.name} {`];
	if (descriptor.doc) lines.push(`\t// ${descriptor.doc}`);
	for (const [verbName, verb] of Object.entries(descriptor.verbs)) {
		const gate = defaultGate(verb.class);
		const note = verb.class === "destructive" ? "  // destructive" : "";
		lines.push(`\tverb "${verbName}" { gate "${gate}" }${note}`);
	}
	lines.push("}");
	return lines.join("\n");
}
