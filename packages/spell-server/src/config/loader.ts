import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { parseManifestKdl } from "../manifest/parser";
import type { AutonomyManifest } from "../manifest/types";
import { validateManifest } from "../manifest/validator";
import { parseChannelsConfig } from "./channels-parser";
import { parseServerConfig } from "./server-parser";
import type { ChannelsConfig, SpellServerConfig } from "./types";

export interface LoadedConfig {
	server: SpellServerConfig;
	channels: ChannelsConfig;
	manifest: AutonomyManifest;
}

export async function loadConfig(configDir: string): Promise<LoadedConfig> {
	const server = parseServerConfig(await readRequiredConfigFile(configDir, "server.kdl"));

	let channels: ChannelsConfig = {};
	try {
		channels = parseChannelsConfig(await Bun.file(path.join(configDir, "channels.kdl")).text());
	} catch (error) {
		if (!isEnoent(error)) {
			throw wrapConfigError("channels.kdl", error);
		}
	}

	const manifestText = await readRequiredConfigFile(configDir, "autonomy.kdl");
	const manifest = parseManifestKdl(manifestText);
	const validation = validateManifest(manifest);
	if (!validation.valid) {
		throw new Error(
			`Invalid manifest: ${validation.errors.map(error => `${error.path}: ${error.message}`).join(", ")}`,
		);
	}

	return { server, channels, manifest };
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

function wrapConfigError(fileName: string, error: unknown): Error {
	return error instanceof Error
		? new Error(`Failed to load ${fileName}: ${error.message}`)
		: new Error(`Failed to load ${fileName}: ${String(error)}`);
}
