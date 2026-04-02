import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { loadConfig } from "@oh-my-pi/spell-server/config/loader";
import { startSpellServer } from "@oh-my-pi/spell-server/server";

export default class Server extends Command {
	static description = "Start the spell autonomy server";

	static flags = {
		"config-dir": Flags.string({
			char: "c",
			description: "Path to config directory containing server.kdl, channels.kdl, autonomy.kdl",
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Server);

		const configDir = flags["config-dir"] ? path.resolve(flags["config-dir"]) : await resolveDefaultConfigDir();

		const config = await loadConfig(configDir);
		const server = await startSpellServer(config, process.cwd());

		let shuttingDown = false;
		const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
			if (shuttingDown) {
				logger.warn("Received second shutdown signal; exiting immediately", { signal });
				process.exit(signal === "SIGINT" ? 130 : 143);
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

		process.on("SIGTERM", () => void shutdown("SIGTERM"));
		process.on("SIGINT", () => void shutdown("SIGINT"));

		logger.debug("Spell server running", {
			configDir,
			configuredPort: config.server.http.port,
			goals: config.manifest.goals.size,
		});
	}
}

async function resolveDefaultConfigDir(): Promise<string> {
	const cwdConfig = path.join(process.cwd(), ".spell");
	try {
		const stats = await fs.stat(cwdConfig);
		if (stats.isDirectory()) {
			return cwdConfig;
		}
	} catch {}
	return path.join(os.homedir(), ".spell");
}
