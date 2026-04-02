#!/usr/bin/env bun
/**
 * Telegram Bridge for Spell
 *
 * Connects Telegram Bot API to Spell's RPC mode, allowing interaction
 * with the coding agent from any device via Telegram.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { loadConfig } from "./config/loader";

async function main() {
	const args = process.argv.slice(2);

	// Support --config flag for custom config path
	let configPath: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--config" && i + 1 < args.length) {
			configPath = args[++i];
		}
	}

	try {
		const config = await loadConfig(configPath);
		logger.debug("Telegram bridge config loaded", {
			projects: Object.keys(config.projects),
			users: Object.keys(config.users).length,
			logViewerPort: config.logViewerPort,
		});

		// Import and start components (lazy to keep startup fast for --help etc.)
		const { startBot } = await import("./bot/bot");
		const { ProcessManager } = await import("./rpc/process-manager");
		const { startLogViewer } = await import("./log-viewer/server");

		const processManager = new ProcessManager(config);
		await processManager.loadState();

		// Start log viewer if configured
		if (config.logViewerPort) {
			startLogViewer(config, processManager);
		}

		// Start the bot (blocks until stopped)
		await startBot(config, processManager);
	} catch (err) {
		logger.error("Telegram bridge failed to start", { error: String(err) });
		console.error(String(err));
		process.exit(1);
	}
}

main();
