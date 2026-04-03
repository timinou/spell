import type { TaskPolicy } from "../config/task-policies";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

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
	gates?: Record<string, boolean>;
	decomposition?: {
		requiredSections?: string[];
	};
	audit?: {
		focusAreas?: string[];
		maxDepth?: number;
		escalation?: boolean | "suggest" | "auto";
	};
	todo?: {
		phases?: Array<{
			name: string;
			tasks?: Array<{
				content: string;
				gateCmd?: string;
				gateLlm?: string;
				gateArtifact?: string;
				gateCommit?: boolean;
			}>;
		}>;
	};
	categories?: string[];
	ui?: {
		canvas?: string;
		overlay?: string;
		primary?: "tui" | "canvas";
	};
	afterComplete?: string;
	contextPolicy?: "fresh" | "carry" | { type: "summarize"; description: string };
	model?: string;
	taskPolicies?: TaskPolicy[];
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
