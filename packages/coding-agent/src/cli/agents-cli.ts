/**
 * Agents CLI command handlers.
 *
 * Handles `spell agents unpack` for writing bundled agent definitions to disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEnoent } from "@spell/pi-utils";

import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import { loadBundledAgents } from "../task/agents";
import type { AgentDefinition } from "../task/types";

export type AgentsAction = "unpack";

export interface AgentsCommandArgs {
	action: AgentsAction;
	flags: {
		force?: boolean;
		json?: boolean;
		dir?: string;
		user?: boolean;
		project?: boolean;
	};
}

interface UnpackResult {
	targetDir: string;
	total: number;
	written: string[];
	skipped: string[];
}

function writeStdout(line: string): void {
	process.stdout.write(`${line}\n`);
}

function resolveTargetDir(flags: AgentsCommandArgs["flags"]): string {
	if (flags.dir && flags.dir.trim().length > 0) {
		return path.resolve(getProjectDir(), flags.dir.trim());
	}

	if (flags.user && flags.project) {
		throw new Error("Choose either --user or --project, not both.");
	}

	if (flags.project) {
		return path.resolve(getProjectDir(), ".spell", "agents");
	}

	return path.join(getAgentDir(), "agents");
}


function serializeAgent(agent: AgentDefinition): string {
	const frontmatter = toKdlFrontmatter(agent);
	const body = agent.systemPrompt.trim();
	return `---kdl\n${frontmatter}\n---\n\n${body}\n`;
}

/**
 * Emit an agent's frontmatter as a KDL document body.
 *
 * Per PLAN-311 WAVE 3: Spell-authored markdown frontmatter uses `---kdl`
 * blocks. The frontmatter parser is dual-mode (still accepts legacy `---`
 * YAML for third-party content), but new files written by Spell tools use
 * KDL by default.
 *
 * KDL conventions:
 *   - keys are kebab-case (parser converts to camelCase)
 *   - string values are quoted positional arguments
 *   - boolean true is a bare node name (parser yields `true` when no args)
 *   - arrays are multiple positional arguments on a single node
 */
function toKdlFrontmatter(agent: AgentDefinition): string {
	const lines: string[] = [];
	lines.push(`name ${kdlString(agent.name)}`);
	lines.push(`description ${kdlString(agent.description)}`);
	if (agent.tools && agent.tools.length > 0) {
		lines.push(`tools ${agent.tools.map(kdlString).join(" ")}`);
	}
	if (agent.spawns !== undefined) {
		if (agent.spawns === "*") {
			lines.push(`spawns ${kdlString("*")}`);
		} else if (Array.isArray(agent.spawns) && agent.spawns.length > 0) {
			lines.push(`spawns ${agent.spawns.map(kdlString).join(" ")}`);
		}
	}
	if (agent.model && agent.model.length > 0) {
		lines.push(`model ${agent.model.map(kdlString).join(" ")}`);
	}
	if (agent.thinkingLevel) lines.push(`thinking-level ${kdlString(agent.thinkingLevel)}`);
	if (agent.output !== undefined) {
		// `output` is `unknown` and is commonly a JSON Schema object. KDL has no
		// native object/map literal, so serialize structured values as a
		// single JSON-encoded string. Scalars pass through verbatim.
		if (typeof agent.output === "string") {
			lines.push(`output ${kdlString(agent.output)}`);
		} else if (typeof agent.output === "number" || typeof agent.output === "boolean") {
			lines.push(`output ${agent.output}`);
		} else {
			lines.push(`output ${kdlString(JSON.stringify(agent.output))}`);
		}
	}
	if (agent.blocking) lines.push("blocking");
	if (agent.scopeRestricted) lines.push("scope-restricted #true");
	if (agent.roster === false) lines.push("roster #false");
	return lines.join("\n");
}

function kdlString(s: string): string {
	return JSON.stringify(s);
}

async function unpackBundledAgents(flags: AgentsCommandArgs["flags"]): Promise<UnpackResult> {
	const targetDir = resolveTargetDir(flags);
	await fs.mkdir(targetDir, { recursive: true });

	const bundledAgents = [...loadBundledAgents()].sort((a, b) => a.name.localeCompare(b.name));
	const written: string[] = [];
	const skipped: string[] = [];

	for (const agent of bundledAgents) {
		const filePath = path.join(targetDir, `${agent.name}.md`);
		if (!flags.force) {
			try {
				await fs.stat(filePath);
				skipped.push(filePath);
				continue;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}

		await Bun.write(filePath, serializeAgent(agent));
		written.push(filePath);
	}

	return {
		targetDir,
		total: bundledAgents.length,
		written,
		skipped,
	};
}

export async function runAgentsCommand(cmd: AgentsCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "unpack": {
			const result = await unpackBundledAgents(cmd.flags);
			if (cmd.flags.json) {
				writeStdout(JSON.stringify(result, null, 2));
				return;
			}

			writeStdout(chalk.bold(`Bundled agents: ${result.total}`));
			writeStdout(chalk.dim(`Target directory: ${result.targetDir}`));
			writeStdout(chalk.green(`${theme.status.success} Written: ${result.written.length}`));
			if (result.skipped.length > 0) {
				writeStdout(
					chalk.yellow(
						`${theme.status.warning} Skipped existing: ${result.skipped.length} (use --force to overwrite)`,
					),
				);
			}

			for (const filePath of result.written) {
				writeStdout(chalk.dim(`  + ${filePath}`));
			}
			for (const filePath of result.skipped) {
				writeStdout(chalk.dim(`  = ${filePath}`));
			}
			return;
		}
	}
}
