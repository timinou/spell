/**
 * SSH CLI command handlers.
 *
 * Handles `spell ssh <command>` subcommands for SSH host configuration management.
 */

import chalk from "chalk";
import { Settings, settings } from "../config/settings";
import type { SshHostKdlEntry } from "../config/kdl-compatibility";

// Local alias — the CLI's user-facing shape matches the KDL writer entry.
type SSHHostConfig = SshHostKdlEntry;

// =============================================================================
// Types
// =============================================================================

export type SSHAction = "add" | "remove" | "list";

export interface SSHCommandArgs {
	action: SSHAction;
	args: string[];
	flags: {
		json?: boolean;
		host?: string;
		user?: string;
		port?: string;
		key?: string;
		desc?: string;
		compat?: boolean;
		scope?: "project" | "user";
	};
}

// =============================================================================
// Main dispatcher
// =============================================================================

export async function runSSHCommand(cmd: SSHCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "add":
			await handleAdd(cmd);
			break;
		case "remove":
			await handleRemove(cmd);
			break;
		case "list":
			await handleList(cmd);
			break;
		default:
			process.stdout.write(chalk.red(`Unknown action: ${cmd.action}\n`));
			process.stdout.write(`Valid actions: add, remove, list\n`);
			process.exitCode = 1;
	}
}

// =============================================================================
// Handlers
// =============================================================================

async function handleAdd(cmd: SSHCommandArgs): Promise<void> {
	const name = cmd.args[0];
	if (!name) {
		process.stdout.write(chalk.red("Error: Host name required\n"));
		process.stdout.write(
			chalk.dim("Usage: spell ssh add <name> --host <address> [--user <user>] [--port <port>] [--key <path>]\n"),
		);
		process.exitCode = 1;
		return;
	}

	const host = cmd.flags.host;
	if (!host) {
		process.stdout.write(chalk.red("Error: --host is required\n"));
		process.stdout.write(chalk.dim("Usage: spell ssh add <name> --host <address>\n"));
		process.exitCode = 1;
		return;
	}

	// Validate port if provided
	if (cmd.flags.port !== undefined) {
		const port = Number.parseInt(cmd.flags.port, 10);
		if (Number.isNaN(port) || port < 1 || port > 65535) {
			process.stdout.write(chalk.red("Error: Port must be an integer between 1 and 65535\n"));
			process.exitCode = 1;
			return;
		}
	}

	const hostConfig: SSHHostConfig = { host };
	if (cmd.flags.user) hostConfig.username = cmd.flags.user;
	if (cmd.flags.port) hostConfig.port = Number.parseInt(cmd.flags.port, 10);
	if (cmd.flags.key) hostConfig.keyPath = cmd.flags.key;
	if (cmd.flags.desc) hostConfig.description = cmd.flags.desc;
	if (cmd.flags.compat) hostConfig.compat = true;

	const scope = cmd.flags.scope ?? "project";

	try {
		await Settings.init();
		const tiers = settings.getPerTier("ssh.hosts" as never);
		const current =
			(scope === "project" ? tiers.project : tiers.user) as Record<string, SSHHostConfig> | undefined;
		const updated = { ...(current ?? {}), [name]: hostConfig };
		settings.set("ssh.hosts" as never, updated as never, scope);
		await settings.flush();
		process.stdout.write(chalk.green(`Added SSH host "${name}" to ${scope} spell.kdl\n`));
	} catch (err) {
		process.stdout.write(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}\n`));
		process.exitCode = 1;
	}
}

async function handleRemove(cmd: SSHCommandArgs): Promise<void> {
	const name = cmd.args[0];
	if (!name) {
		process.stdout.write(chalk.red("Error: Host name required\n"));
		process.stdout.write(chalk.dim("Usage: spell ssh remove <name> [--scope project|user]\n"));
		process.exitCode = 1;
		return;
	}

	const scope = cmd.flags.scope ?? "project";

	try {
		await Settings.init();
		const tiers = settings.getPerTier("ssh.hosts" as never);
		const current =
			(scope === "project" ? tiers.project : tiers.user) as Record<string, SSHHostConfig> | undefined;
		if (!current || !(name in current)) {
			process.stdout.write(chalk.yellow(`No host "${name}" in ${scope} spell.kdl\n`));
			return;
		}
		const { [name]: _, ...rest } = current;
		void _;
		settings.set("ssh.hosts" as never, rest as never, scope);
		await settings.flush();
		process.stdout.write(chalk.green(`Removed SSH host "${name}" from ${scope} spell.kdl\n`));
	} catch (err) {
		process.stdout.write(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}\n`));
		process.exitCode = 1;
	}
}

async function handleList(cmd: SSHCommandArgs): Promise<void> {
	await Settings.init();
	const tiers = settings.getPerTier("ssh.hosts" as never);
	const projectHosts = ((tiers.project as Record<string, SSHHostConfig> | undefined) ?? {});
	const userHosts = ((tiers.user as Record<string, SSHHostConfig> | undefined) ?? {});

	if (cmd.flags.json) {
		process.stdout.write(JSON.stringify({ project: projectHosts, user: userHosts }, null, 2));
		process.stdout.write("\n");
		return;
	}

	const hasProject = Object.keys(projectHosts).length > 0;
	const hasUser = Object.keys(userHosts).length > 0;

	if (!hasProject && !hasUser) {
		process.stdout.write(chalk.dim("No SSH hosts configured\n"));
		process.stdout.write(chalk.dim("Add one with: spell ssh add <name> --host <address>\n"));
		return;
	}

	if (hasProject) {
		process.stdout.write(chalk.bold("Project SSH Hosts (./spell.kdl):\n"));
		printHosts(projectHosts);
	}

	if (hasProject && hasUser) {
		process.stdout.write("\n");
	}

	if (hasUser) {
		process.stdout.write(chalk.bold("User SSH Hosts (~/.config/spell/spell.kdl):\n"));
		printHosts(userHosts);
	}
}

// =============================================================================
// Helpers
// =============================================================================

function printHosts(hosts: Record<string, SSHHostConfig>): void {
	for (const [name, config] of Object.entries(hosts)) {
		const parts = [chalk.cyan(name), config.host];
		if (config.username) parts.push(chalk.dim(config.username));
		if (config.port && config.port !== 22) parts.push(chalk.dim(`port:${config.port}`));
		if (config.keyPath) parts.push(chalk.dim(config.keyPath));
		if (config.description) parts.push(chalk.dim(`- ${config.description}`));
		process.stdout.write(`  ${parts.join("  ")}\n`);
	}
}
