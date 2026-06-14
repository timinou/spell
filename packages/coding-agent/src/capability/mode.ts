import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Frontmatter for a workflow role (KDL `mode` block / `.spell/modes/*.md`).
 * Roles desugar to the unified {@link Discipline} primitive (FEAT-816); this
 * shape is the manual-trigger sugar surface. Fields here are the LIVE set — the
 * dead aspirational fields (decomposition/todo/afterComplete/ui/gates/categories/
 * taskPolicies) and the never-implemented `summarize` cadence were removed in the
 * W4 convergence. Re-add a field only alongside a real consumer.
 */
export interface ModeConfigFrontmatter {
	name?: string;
	description?: string;
	extends?: string;
	command?: string;
	readOnly?: boolean;
	tools?: {
		allow?: string[];
		deny?: string[];
	};
	audit?: {
		focusAreas?: string[];
		maxDepth?: number;
		escalation?: boolean | "suggest" | "auto";
	};
	/** Injection cadence: `carry` re-injects every turn, `fresh` once per activation. */
	contextPolicy?: "fresh" | "carry";
	model?: string;
}

export interface ModeConfigSections {
	context?: string;
	instructions?: string;
	focusAreas?: string;
	examples?: string;
	planPhase?: string;
	codePhase?: string;
	reviewPhase?: string;
	custom: Record<string, string>;
}

export interface ModeConfig {
	name: string;
	path: string;
	frontmatter: ModeConfigFrontmatter;
	sections: ModeConfigSections;
	level: "user" | "project";
	_source: SourceMeta;
}

export interface ResolvedModeConfig {
	name: string;
	path: string;
	frontmatter: ModeConfigFrontmatter;
	sections: ModeConfigSections;
	level: "user" | "project";
	_source: SourceMeta;
	resolvedTools?: string[];
	extendsChain: string[];
}

export const modeConfigCapability = defineCapability<ModeConfig>({
	id: "modes",
	displayName: "Modes",
	description: "User-definable workflow modes from .spell/modes/ directories",
	key: mode => mode.name,
	validate: mode => {
		if (!mode.name) return "Missing mode name";
		if (mode.frontmatter.tools?.allow && mode.frontmatter.tools?.deny) {
			return `Mode "${mode.name}": tools.allow and tools.deny are mutually exclusive`;
		}
		return undefined;
	},
	toExtensionId: mode => `mode:${mode.name}`,
});
