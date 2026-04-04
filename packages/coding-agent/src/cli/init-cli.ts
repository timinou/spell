import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
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

	const overrides = generatePolicyOverrides(project, templateNamespace);
	if (overrides.length > 0) {
		lines.push("");
		lines.push("// Project-specific policy overrides");
		lines.push("// The imported template provides base layers and policies.");
		lines.push("// Policies declared here override the template by name.");
		lines.push(...overrides);
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
