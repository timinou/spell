/**
 * Config loader for ~/.spell/telegram.yaml
 */

import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { parse as parseYaml } from "yaml";
import type { RawTelegramConfig, TelegramBridgeConfig, UserConfig } from "./types";

const DEFAULT_UPLOAD_DIR = "/tmp/telegram-uploads";
const DEFAULT_IDLE_TIMEOUT = 3600; // 1 hour
const DEFAULT_MAX_SESSIONS = 3;

/** Resolve the config file path */
export function getConfigPath(): string {
	return path.join(os.homedir(), ".spell", "telegram.yaml");
}

/** Load and validate the Telegram bridge config */
export async function loadConfig(configPath?: string): Promise<TelegramBridgeConfig> {
	const filePath = configPath ?? getConfigPath();

	let rawText: string;
	try {
		rawText = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(
				`Config file not found: ${filePath}\n` +
					`Create it with your bot token and user config.\n` +
					`Example path: ~/.spell/telegram.yaml`,
			);
		}
		throw err;
	}

	const raw = parseYaml(rawText) as RawTelegramConfig;
	if (!raw || typeof raw !== "object") {
		throw new Error(`Invalid config: expected YAML object in ${filePath}`);
	}

	return validateAndResolve(raw, filePath);
}

/** Validate raw config and resolve paths/defaults */
export async function validateAndResolve(raw: RawTelegramConfig, configPath: string): Promise<TelegramBridgeConfig> {
	// bot_token_file is required
	if (!raw.bot_token_file) {
		throw new Error("Config missing required field: bot_token_file");
	}

	// Resolve bot_token_file relative to config directory
	const configDir = path.dirname(configPath);
	const tokenFilePath = path.isAbsolute(raw.bot_token_file)
		? raw.bot_token_file
		: path.join(configDir, raw.bot_token_file);

	let botToken: string;
	try {
		botToken = (await Bun.file(tokenFilePath).text()).trim();
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(`Bot token file not found: ${tokenFilePath}`);
		}
		throw new Error(`Cannot read bot token file: ${tokenFilePath}: ${err}`);
	}

	if (!botToken) {
		throw new Error(`Bot token file is empty: ${tokenFilePath}`);
	}

	// Resolve projects (paths to absolute)
	const projects: Record<string, string> = {};
	if (raw.projects) {
		for (const [name, projectPath] of Object.entries(raw.projects)) {
			const resolved = path.isAbsolute(projectPath) ? projectPath : path.resolve(configDir, projectPath);
			projects[name] = resolved;
		}
	}

	// Validate and resolve users
	const users: Record<string, UserConfig> = {};
	if (raw.users) {
		for (const [rawId, rawUser] of Object.entries(raw.users)) {
			// YAML may parse bare numbers as number type; coerce to string
			const userId = String(rawId);
			if (!userId || userId === "undefined") {
				throw new Error(`Invalid user ID in config: ${rawId}`);
			}

			const modes = rawUser?.modes ?? ["telegram-readonly"];
			const defaultMode = rawUser?.default_mode ?? modes[0];
			if (!modes.includes(defaultMode)) {
				logger.warn("User default_mode not in modes list", { userId, defaultMode, modes });
			}

			users[userId] = {
				modes,
				defaultMode,
				idleTimeout: rawUser?.idle_timeout,
				projects: rawUser?.projects,
			};
		}
	}

	// Warn about empty users map
	if (Object.keys(users).length === 0) {
		logger.warn("No users configured -- bot will reject all messages");
	}

	// Resolve upload dir
	const uploadDir = raw.upload_dir ?? DEFAULT_UPLOAD_DIR;

	return {
		botTokenFile: tokenFilePath,
		botToken,
		uploadDir,
		logViewerPort: raw.log_viewer_port,
		idleTimeout: raw.idle_timeout ?? DEFAULT_IDLE_TIMEOUT,
		maxSessions: raw.max_sessions ?? DEFAULT_MAX_SESSIONS,
		projects,
		users,
		defaultProject: raw.default_project ?? Object.keys(projects)[0],
	};
}
