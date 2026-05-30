import * as path from "node:path";

import { isEnoent } from "@spell/pi-utils";
import chalk from "chalk";

import { type DetectedProject, detectProject, type ProjectLanguage } from "../config/project-detection";

export interface InitCommandArgs {
	flags: { force?: boolean; domain?: string };
}

const LANGUAGE_TEMPLATES: Partial<Record<ProjectLanguage, string>> = {
	typescript: "spell.coding.typescript",
	javascript: "spell.coding.typescript",
	rust: "spell.coding.rust",
	python: "spell.coding.python",
	go: "spell.coding.go",
};

interface TemplatePolicyDefaults {
	api?: { gateCmd?: string; verifyCmd?: string };
	ui?: { gateCmd?: string; verifyCmd?: string };
}

const TEMPLATE_POLICY_DEFAULTS: Partial<Record<ProjectLanguage, TemplatePolicyDefaults>> = {
	typescript: {
		api: { gateCmd: "bun test" },
		ui: { gateCmd: "bun test" },
	},
	javascript: {
		api: { gateCmd: "bun test" },
		ui: { gateCmd: "bun test" },
	},
	rust: {
		api: { gateCmd: "cargo test", verifyCmd: "cargo clippy -- -D warnings" },
	},
	python: {
		api: { gateCmd: "pytest", verifyCmd: "mypy" },
	},
	go: {
		api: { gateCmd: "go test ./...", verifyCmd: "go vet ./..." },
	},
};

function selectTemplate(project: DetectedProject, domainOverride?: string): string | undefined {
	if (domainOverride === "growth") return "spell.growth.default";
	return LANGUAGE_TEMPLATES[project.language];
}

function generateSpellKdl(project: DetectedProject, domain: string, templateNamespace: string | undefined): string {
	const lines: string[] = [
		"// Spell project configuration",
		"// Docs: https://github.com/can1357/oh-my-pi",
		"",
		`domain ${JSON.stringify(domain)}`,
	];

	if (templateNamespace) {
		lines.push(`import ${JSON.stringify(templateNamespace)}`);
	}

	lines.push(
		"",
		"appearance {",
		'\t// theme dark="titanium" light="light"',
		'\t// symbols "unicode"',
		"\t// color-blind #false",
		'\t// status-line preset="default" separator="powerline-thin" {',
		'\t// \tleft "pi" "model" "plan_mode" "path" "git"',
		'\t// \tright "token_total" "cost" "context_pct" "time"',
		"\t// \tshow-hook-status #true",
		"\t// }",
		"\t// images show-inline=#true auto-resize=#true",
		"}",
		"",
		"model {",
		'\t// thinking "high"',
		"\t// max-thinking-tokens 16384",
		"\troles {",
		'\t\t// default "anthropic/claude-sonnet-4-20250514"',
		'\t\t// smol "anthropic/claude-haiku-3"',
		'\t\t// slow "anthropic/claude-sonnet-4-20250514"',
		'\t\t// task "anthropic/claude-sonnet-4-20250514"',
		'\t\t// commit "anthropic/claude-haiku-3"',
		"\t}",
		"\t// sampling {",
		"\t// \ttemperature -1",
		"\t// \ttop-p -1",
		"\t// \ttop-k -1",
		'\t// \tservice-tier "none"',
		"\t// }",
		"\t// retry max=3 backoff-ms=1000",
		'\t// compaction enabled=#true threshold=0.7 strategy="context-full"',
		"}",
		"",
		"providers {",
		'\t// provider "anthropic" {',
		'\t// \tapi-key "$ANTHROPIC_API_KEY"',
		"\t// }",
		"}",
		"",
		"tools {",
		"\t// intent-tracing #true",
		"\t// max-timeout 0",
		"\t// bash enabled=#true",
		"\t// fetch enabled=#true",
		"\t// browser enabled=#true headless=#true",
		"\t// org enabled=#true",
		"\t// checkpoint enabled=#false",
		"\t// mcp project-config=#true discovery-mode=#false notifications=#false",
		"\t// async enabled=#false max-jobs=100",
		"}",
		"",
		"tasks {",
		"\t// eager #false",
		"\t// auto-roster #true",
		"\t// max-concurrency 32",
		"\t// max-recursion 2",
		"\t// max-tool-calls 200",
		"\t// cache-stagger-ms 800",
		'\t// isolation mode="none" merge="patch" commits="generic"',
		"}",
		"",
		"interaction {",
		"\t// steering #true",
		'\t// caveman enabled=#false level="full"',
		"\t// auto-compact #true",
		"\tcontext max-file-lines=2000 {",
		'\t\t// promotion enabled=#true target="slow"',
		"\t}",
		"\tediting {",
		"\t\t// auto-format #true",
		"\t\t// preserve-indentation #true",
		"\t}",
		"}",
		"",
		"keybindings {",
		'\t// interrupt "escape"',
		'\t// clear "ctrl+c"',
		'\t// exit "ctrl+d"',
		'\t// cycle-thinking-level "shift+tab"',
		'\t// cycle-model-forward "ctrl+p"',
		'\t// cycle-model-backward "shift+ctrl+p"',
		'\t// select-model "ctrl+l"',
		'\t// toggle-plan-mode "alt+shift+p"',
		'\t// history-search "ctrl+r"',
		'\t// expand-tools "ctrl+o"',
		'\t// toggle-thinking "ctrl+t"',
		'\t// external-editor "ctrl+g"',
		'\t// follow-up "ctrl+enter"',
		'\t// paste-image "ctrl+v"',
		'\t// toggle-stt "alt+h"',
		"}",
		"",
		"skills {",
		"\t// enabled #true",
		"\t// enable-commands #true",
		'\t// custom-directories "./custom-skills"',
		'\t// ignored "voice-agent"',
		"}",
		"",
		"org {",
		"\t// enabled #true",
		'\t// todo-keywords "INIT" "ITEM" "DOING" "REVIEW" "DONE" "BLOCKED"',
		"}",
	);

	const overrides = generatePolicyOverrides(project, templateNamespace);
	if (overrides.length > 0) {
		lines.push(
			"",
			"// Project-specific policy overrides",
			"// The imported template provides base layers and policies.",
			"// Policies declared here override the template by name.",
			...overrides,
		);
	}

	lines.push("");
	return lines.join("\n");
}

function createPolicyBlock(name: string, layer: string, commands: { gateCmd?: string; verifyCmd?: string }): string[] {
	const lines = [`policy ${JSON.stringify(name)} layer=${JSON.stringify(layer)} {`, "    gate-commit #true"];
	if (commands.gateCmd) {
		lines.push(`    gate-cmd ${JSON.stringify(commands.gateCmd)}`);
	}
	if (commands.verifyCmd) {
		lines.push(`    verify-cmd ${JSON.stringify(commands.verifyCmd)}`);
	}
	lines.push("}");
	return lines;
}

function differsFromDefault(
	value: { gateCmd?: string; verifyCmd?: string },
	defaults?: { gateCmd?: string; verifyCmd?: string },
): boolean {
	return value.gateCmd !== defaults?.gateCmd || value.verifyCmd !== defaults?.verifyCmd;
}

function generatePolicyOverrides(project: DetectedProject, templateNamespace: string | undefined): string[] {
	if (templateNamespace === "spell.growth.default") {
		return [];
	}

	const defaults = TEMPLATE_POLICY_DEFAULTS[project.language];
	const apiCommands = {
		gateCmd: project.toolchain.testCmd,
		verifyCmd: project.toolchain.checkCmd,
	};
	const uiCommands = {
		gateCmd: project.toolchain.testCmd,
	};
	const lines: string[] = [];

	if ((apiCommands.gateCmd || apiCommands.verifyCmd) && differsFromDefault(apiCommands, defaults?.api)) {
		lines.push(...createPolicyBlock("api-quality", "api", apiCommands));
	}

	if (uiCommands.gateCmd && differsFromDefault(uiCommands, defaults?.ui)) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push(...createPolicyBlock("ui-quality", "ui", uiCommands));
	}

	return lines;
}

function formatProjectOverview(project: DetectedProject): string {
	const details: string[] = [];
	if (project.language !== "unknown") {
		details.push(project.language);
	}
	if (project.frameworks.length > 0) {
		details.push(`${project.frameworks.join(", ")}`);
	}
	return details.length > 0 ? `${project.name} -- ${details[0]}${details[1] ? ` (${details[1]})` : ""}` : project.name;
}

function generateAgentsMd(project: DetectedProject): string {
	const lines: string[] = ["# Project Context", "", "## Overview", formatProjectOverview(project), ""];

	const devCmds: string[] = [];
	if (project.toolchain.testCmd) devCmds.push(`- Test: \`${project.toolchain.testCmd}\``);
	if (project.toolchain.checkCmd) devCmds.push(`- Check: \`${project.toolchain.checkCmd}\``);
	if (project.toolchain.lintCmd) devCmds.push(`- Lint: \`${project.toolchain.lintCmd}\``);
	if (project.toolchain.formatCmd) devCmds.push(`- Format: \`${project.toolchain.formatCmd}\``);

	if (devCmds.length > 0) {
		lines.push("## Development", ...devCmds, "");
	}

	lines.push("## Conventions");
	lines.push("<!-- Add project-specific conventions here -->");
	lines.push("");

	return lines.join("\n");
}

export async function runInitCommand(args: InitCommandArgs): Promise<void> {
	const cwd = process.cwd();
	const spellKdlPath = path.join(cwd, "spell.kdl");

	if (!args.flags.force) {
		try {
			await Bun.file(spellKdlPath).text();
			process.stdout.write(`${chalk.yellow("spell.kdl already exists")}: ${spellKdlPath}\n`);
			process.stdout.write(`${chalk.dim("Re-run with --force to overwrite.")}\n`);
			return;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}

	const project = await detectProject(cwd);
	const domain = args.flags.domain ?? "coding";
	const templateNamespace = selectTemplate(project, args.flags.domain);
	const spellKdlContent = generateSpellKdl(project, domain, templateNamespace);
	await Bun.write(spellKdlPath, spellKdlContent);

	const agentsMdPath = path.join(cwd, ".spell", "AGENTS.md");
	let writeAgentsMd = args.flags.force ?? false;
	if (!writeAgentsMd) {
		try {
			await Bun.file(agentsMdPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				writeAgentsMd = true;
			} else {
				throw error;
			}
		}
	}

	if (writeAgentsMd) {
		await Bun.write(agentsMdPath, generateAgentsMd(project));
	}

	process.stdout.write("\n");
	if (project.language !== "unknown") {
		const projectInfo: string[] = [project.language];
		if (project.frameworks.length > 0) {
			projectInfo.push(project.frameworks.join(", "));
		}
		process.stdout.write(
			`  ${chalk.cyan("Detected")}: ${projectInfo[0]}${projectInfo[1] ? ` (${projectInfo[1]})` : ""}\n`,
		);
	}
	if (project.toolchain.testCmd) process.stdout.write(`  ${chalk.cyan("Test")}:     ${project.toolchain.testCmd}\n`);
	if (project.toolchain.checkCmd) process.stdout.write(`  ${chalk.cyan("Check")}:    ${project.toolchain.checkCmd}\n`);
	if (project.toolchain.lintCmd) process.stdout.write(`  ${chalk.cyan("Lint")}:     ${project.toolchain.lintCmd}\n`);
	process.stdout.write("\n");
	process.stdout.write(`  ${chalk.green("Created")}: spell.kdl\n`);
	if (writeAgentsMd) {
		process.stdout.write(`  ${chalk.green("Created")}: .spell/AGENTS.md\n`);
	}
	process.stdout.write("\n");
	process.stdout.write(`  Run ${chalk.bold("spell")} to start a session with policies active.\n`);
	process.stdout.write("\n");
}
