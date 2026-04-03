import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { createBuiltinActionRegistry } from "../actions";
import type { ActionRegistry } from "../actions/registry";
import { loadManifestFromFile } from "../manifest/import-resolver";
import type { AutonomyManifest } from "../manifest/types";
import { parseChannelsConfig, resolveChannelsBotToken } from "./channels-parser";
import { parseServerConfig } from "./server-parser";
import type { ChannelsConfig, SpellServerConfig } from "./types";

export interface LoadedConfig {
	server: SpellServerConfig;
	channels: ChannelsConfig;
	manifest: AutonomyManifest;
	actionRegistry: ActionRegistry;
}

export async function loadConfig(configDir: string): Promise<LoadedConfig> {
	const server = parseServerConfig(await readRequiredConfigFile(configDir, "server.kdl"));

	let channels: ChannelsConfig = {};
	try {
		channels = parseChannelsConfig(await Bun.file(path.join(configDir, "channels.kdl")).text(), configDir);
		channels = await resolveChannelsBotToken(channels, configDir);
	} catch (error) {
		if (!isEnoent(error)) {
			throw wrapConfigError("channels.kdl", error);
		}
	}

	const actionRegistry = createBuiltinActionRegistry();
	const manifestPath = path.join(configDir, "autonomy.kdl");
	const manifest = await loadManifestFromFile(manifestPath, {
		registry: actionRegistry,
		env: process.env,
	});

	return { server, channels, manifest, actionRegistry };
}

async function readRequiredConfigFile(configDir: string, fileName: string): Promise<string> {
	try {
		return await Bun.file(path.join(configDir, fileName)).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`Missing required config file: ${path.join(configDir, fileName)}`);
		}
		throw wrapConfigError(fileName, error);
	}
}

const CHANNELS_NULL_KEYWORD_ERROR = /Invalid keyword "null"/;

function wrapConfigError(fileName: string, error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`Failed to load ${fileName}: ${formatConfigErrorMessage(fileName, message)}`);
}

function formatConfigErrorMessage(fileName: string, message: string): string {
	if (fileName === "channels.kdl" && CHANNELS_NULL_KEYWORD_ERROR.test(message)) {
		return `${message}. In channels.kdl, use #null for null values, for example idle-timeout #null.`;
	}

	return message;
}
