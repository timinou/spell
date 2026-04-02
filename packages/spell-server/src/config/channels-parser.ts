import * as path from "node:path";
import { type Node, parse } from "@bgotink/kdl";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { ChannelsConfig, TelegramUserConfig } from "./types";

const DEFAULT_UPLOAD_DIR = "/tmp/spell-telegram-uploads";
const DEFAULT_IDLE_TIMEOUT = 3600; // 1 hour
const DEFAULT_MAX_SESSIONS = 3;

export function parseChannelsConfig(kdlText: string, configDir?: string): ChannelsConfig {
	const document = parse(kdlText);
	const telegramNode = document.findNodeByName("telegram");
	if (!telegramNode) {
		return {};
	}

	let botToken: string | undefined;
	let botTokenFile: string | undefined;
	let owners: number[] | undefined;
	let uploadDir = DEFAULT_UPLOAD_DIR;
	let idleTimeout = DEFAULT_IDLE_TIMEOUT;
	let maxSessions = DEFAULT_MAX_SESSIONS;
	let logViewerPort: number | undefined;
	let defaultProject: string | undefined;
	let defaultModel: string | undefined;
	const projects: Record<string, string> = {};
	const users: Record<string, TelegramUserConfig> = {};

	for (const child of telegramNode.children?.nodes ?? []) {
		const name = child.getName();

		if (name === "bot-token") {
			const value = child.getArgument(0);
			if (typeof value !== "string" || value.length === 0) {
				throw new Error("channels.telegram.bot-token must have a non-empty string argument");
			}
			botToken = value;
			continue;
		}

		if (name === "bot-token-file") {
			const value = child.getArgument(0);
			if (typeof value !== "string" || value.length === 0) {
				throw new Error("channels.telegram.bot-token-file must have a non-empty string argument");
			}
			botTokenFile = value;
			continue;
		}

		if (name === "owners") {
			const values = child.getArguments();
			if (!values.every(value => typeof value === "number" && Number.isFinite(value))) {
				throw new Error("channels.telegram.owners must contain only numeric chat ids");
			}
			owners = values as number[];
			continue;
		}

		if (name === "upload-dir") {
			const value = child.getArgument(0);
			if (typeof value !== "string" || value.length === 0) {
				throw new Error("channels.telegram.upload-dir must have a non-empty string argument");
			}
			uploadDir = value;
			continue;
		}

		if (name === "idle-timeout") {
			const value = child.getArgument(0);
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error("channels.telegram.idle-timeout must be a number");
			}
			idleTimeout = value;
			continue;
		}

		if (name === "max-sessions") {
			const value = child.getArgument(0);
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error("channels.telegram.max-sessions must be a number");
			}
			maxSessions = value;
			continue;
		}

		if (name === "log-viewer-port") {
			const value = child.getArgument(0);
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error("channels.telegram.log-viewer-port must be a number");
			}
			logViewerPort = value;
			continue;
		}

		if (name === "default-project") {
			const value = child.getArgument(0);
			if (typeof value !== "string" || value.length === 0) {
				throw new Error("channels.telegram.default-project must have a non-empty string argument");
			}
			defaultProject = value;
			continue;
		}

		if (name === "default-model") {
			const value = child.getArgument(0);
			if (typeof value !== "string" || value.length === 0) {
				throw new Error("channels.telegram.default-model must have a non-empty string argument");
			}
			defaultModel = value;
			continue;
		}

		if (name === "project") {
			const args = child.getArguments();
			if (args.length !== 2 || typeof args[0] !== "string" || typeof args[1] !== "string") {
				throw new Error("channels.telegram.project requires exactly two string arguments: name and path");
			}
			const projectPath = path.isAbsolute(args[1]) ? args[1] : path.resolve(configDir ?? ".", args[1]);
			projects[args[0]] = projectPath;
			continue;
		}

		if (name === "user") {
			parseUserNode(child, users);
		}
	}

	// Validate mutual exclusivity
	if (botToken && botTokenFile) {
		throw new Error("channels.telegram: bot-token and bot-token-file are mutually exclusive");
	}

	if (!defaultModel) {
		throw new Error("channels.telegram.default-model is required");
	}

	if (!botToken && !botTokenFile && !owners) {
		return {};
	}

	if (!botToken && !botTokenFile) {
		throw new Error("channels.telegram: bot-token or bot-token-file is required");
	}
	if (!owners) {
		throw new Error("channels.telegram.owners is required");
	}

	// Resolve bot-token-file to actual token (synchronously deferred to loader)
	const resolvedToken = botToken ?? `file:${botTokenFile}`;

	return {
		telegram: {
			botToken: resolvedToken,
			owners,
			uploadDir,
			idleTimeout,
			maxSessions,
			logViewerPort,
			defaultModel,
			defaultProject: defaultProject ?? Object.keys(projects)[0],
			projects,
			users,
		},
	};
}

/**
 * Resolve bot-token-file references after parsing.
 * Call this after parseChannelsConfig when config.telegram.botToken starts with "file:".
 */
export async function resolveChannelsBotToken(config: ChannelsConfig, configDir: string): Promise<ChannelsConfig> {
	if (!config.telegram?.botToken.startsWith("file:")) {
		return config;
	}

	const tokenFilePath = config.telegram.botToken.slice(5);
	const resolvedPath = path.isAbsolute(tokenFilePath) ? tokenFilePath : path.join(configDir, tokenFilePath);

	let token: string;
	try {
		token = (await Bun.file(resolvedPath).text()).trim();
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(`Bot token file not found: ${resolvedPath}`);
		}
		throw new Error(`Cannot read bot token file: ${resolvedPath}: ${err}`);
	}
	if (!token) {
		throw new Error(`Bot token file is empty: ${resolvedPath}`);
	}

	return {
		...config,
		telegram: {
			...config.telegram,
			botToken: token,
		},
	};
}

function parseUserNode(node: Node, users: Record<string, TelegramUserConfig>): void {
	const userIdArg = node.getArgument(0);
	if (typeof userIdArg !== "number" || !Number.isFinite(userIdArg)) {
		throw new Error("channels.telegram.user requires a numeric user ID argument");
	}
	const userId = String(Math.floor(userIdArg));

	let modes: string[] = ["telegram-readonly"];
	let defaultMode: string | undefined;
	let idleTimeout: number | null | undefined;
	let userProjects: string[] | undefined;

	for (const child of node.children?.nodes ?? []) {
		const name = child.getName();

		if (name === "modes") {
			const values = child.getArguments();
			if (!values.every(v => typeof v === "string")) {
				throw new Error(`channels.telegram.user[${userId}].modes must be strings`);
			}
			modes = values as string[];
			continue;
		}

		if (name === "default-mode") {
			const value = child.getArgument(0);
			if (typeof value !== "string") {
				throw new Error(`channels.telegram.user[${userId}].default-mode must be a string`);
			}
			defaultMode = value;
			continue;
		}

		if (name === "idle-timeout") {
			const value = child.getArgument(0);
			if (value === null) {
				idleTimeout = null;
			} else if (typeof value === "number" && Number.isFinite(value)) {
				idleTimeout = value;
			} else {
				throw new Error(`channels.telegram.user[${userId}].idle-timeout must be a number or null`);
			}
			continue;
		}

		if (name === "projects") {
			const values = child.getArguments();
			if (!values.every(v => typeof v === "string")) {
				throw new Error(`channels.telegram.user[${userId}].projects must be strings`);
			}
			userProjects = values as string[];
		}
	}

	users[userId] = {
		modes,
		defaultMode: defaultMode ?? modes[0],
		idleTimeout,
		projects: userProjects,
	};
}
