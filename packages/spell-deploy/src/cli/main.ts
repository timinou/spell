#!/usr/bin/env bun

import {
	bootstrapCommand,
	initCommand,
	pullCommand,
	pushCommand,
	resolveContext,
	secretsCommand,
	statusCommand,
	watchCommand,
} from "./commands";

const USAGE = `Usage: spell deploy <command> [target] [options]

Commands:
  init        Provision remote (dirs, bundle, systemd unit)
  push        Stop service + atomic push + start service
  pull        SQLite backup + rsync pull state
  watch       Continuous bidirectional sync
  status      Check remote health
  secrets     Decrypt and push .env
  bootstrap   init + secrets + push

Options:
  --dry-run   Show commands without executing
  --target    Target name (default: from sync.kdl)
  --cwd       Project root directory
`;

export async function main(args: string[]): Promise<void> {
	const command = args[0];
	if (!command || command === "--help" || command === "-h") {
		console.error(USAGE);
		return;
	}

	const dryRun = args.includes("--dry-run");
	let targetName: string | undefined;
	let cwd: string | undefined;

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dry-run") {
			continue;
		}
		if (arg === "--target" && args[i + 1]) {
			targetName = args[++i];
			continue;
		}
		if (arg === "--cwd" && args[i + 1]) {
			cwd = args[++i];
			continue;
		}
		if (!arg.startsWith("--")) {
			targetName = arg;
		}
	}

	const { context, config, target } = await resolveContext({
		projectRoot: cwd,
		targetName,
		dryRun,
	});

	switch (command) {
		case "init":
			await initCommand(context, config, target);
			break;
		case "push":
			await pushCommand(context, config, target);
			break;
		case "pull":
			await pullCommand(context, config, target);
			break;
		case "watch": {
			const orchestrator = watchCommand(context, config, target);
			orchestrator.start();
			console.error(`Watching ${context.targetName}... Press Ctrl+C to stop.`);
			process.on("SIGINT", () => {
				orchestrator.stop();
				process.exit(0);
			});
			break;
		}
		case "status": {
			const result = await statusCommand(context, config, target);
			console.error(`Service: ${result.serviceRunning ? "running" : "stopped"}`);
			console.error(`Health: ${result.healthOk ? "ok" : "unhealthy"}`);
			if (result.error) {
				console.error(`Error: ${result.error}`);
			}
			break;
		}
		case "secrets":
			await secretsCommand(context, config, target);
			break;
		case "bootstrap":
			await bootstrapCommand(context, config, target);
			break;
		default:
			console.error(`Unknown command: ${command}\n${USAGE}`);
			process.exit(1);
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
