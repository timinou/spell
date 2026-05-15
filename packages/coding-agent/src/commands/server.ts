import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
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
		debug: Flags.boolean({
			description: "Mirror spell-server logs to stderr while preserving file logging",
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Server);

		logger.setStderrDebugEnabled(flags.debug === true);

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

export async function resolveDefaultConfigDir(): Promise<string> {
	const cwdConfig = path.join(process.cwd(), ".spell");
	try {
		const stats = await fs.stat(cwdConfig);
		if (stats.isDirectory()) {
			return cwdConfig;
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	// Fall back to the global config in ~/.spell ONLY when it actually contains
	// a spell-server entrypoint. ~/.spell is shared with coding-agent (which puts
	// `spell.kdl` there for its own, unrelated config). Probing server.kdl avoids
	// committing to a directory that exists but will never satisfy loadConfig —
	// which would otherwise produce a misleading error path.
	const homeConfig = path.join(os.homedir(), ".spell");
	try {
		await fs.stat(path.join(homeConfig, "server.kdl"));
		return homeConfig;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	throw new Error(
		`No spell-server config directory found. Tried:\n` +
			`  - ${cwdConfig}/ (current workspace)\n` +
			`  - ${homeConfig}/server.kdl (global)\n` +
			`Pass --config-dir <path> to point at one explicitly, or create one of the above.`,
	);
}
