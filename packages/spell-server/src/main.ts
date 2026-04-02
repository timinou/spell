#!/usr/bin/env bun
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { loadConfig } from "./config/loader";
import { startSpellServer } from "./server";

function resolveConfigDir(args: string[]): string {
	const configDirIndex = args.indexOf("--config-dir");
	if (configDirIndex === -1) {
		return path.join(process.cwd(), ".spell");
	}
	const configDir = args[configDirIndex + 1];
	if (!configDir) {
		throw new Error("--config-dir requires a path argument");
	}
	return path.resolve(configDir);
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
	return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

async function main(): Promise<void> {
	const configDir = resolveConfigDir(process.argv.slice(2));
	const config = await loadConfig(configDir);
	const server = await startSpellServer(config, process.cwd());

	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) {
			logger.warn("Received second shutdown signal; exiting immediately", { signal });
			process.exit(exitCodeForSignal(signal));
		}
		shuttingDown = true;
		logger.debug("Shutting down spell server", { signal });
		try {
			await server.stop();
			process.exit(0);
		} catch (error) {
			logger.error("Failed to stop spell server cleanly", { signal, error: String(error) });
			process.exit(1);
		}
	};

	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});

	logger.debug("Spell server running", {
		configDir,
		configuredPort: config.server.http.port,
		goals: config.manifest.goals.size,
	});
}

if (import.meta.main) {
	main().catch(error => {
		logger.error("Failed to start spell server", { error: String(error) });
		process.exit(1);
	});
}
