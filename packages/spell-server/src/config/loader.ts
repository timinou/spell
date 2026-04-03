import * as path from "node:path";
import { isEnoent, parseEnvFile } from "@oh-my-pi/pi-utils";
import { createBuiltinActionRegistry } from "../actions";
import type { ActionRegistry } from "../actions/registry";
import { loadManifestFromFile } from "../manifest/import-resolver";
import type { AutonomyManifest } from "../manifest/types";
import { parseChannelsConfig, resolveChannelsBotToken } from "./channels-parser";
import { type EnvReferenceInfo, formatEnvReport, scanEnvReferences, validateEnvReferences } from "./env-resolver";
import { type DotenvConfig, parseDotenvConfig, parseServerConfig } from "./server-parser";
import type { ChannelsConfig, SpellServerConfig } from "./types";

export interface LoadedConfig {
	server: SpellServerConfig;
	channels: ChannelsConfig;
	manifest: AutonomyManifest;
	actionRegistry: ActionRegistry;
}

export async function loadConfig(configDir: string): Promise<LoadedConfig> {
	// Phase 1: Read server.kdl and extract dotenv config (meta-config)
	const serverKdlText = await readRequiredConfigFile(configDir, "server.kdl");
	const dotenvConfig = parseDotenvConfig(serverKdlText);

	// Phase 2: Load .env file if dotenv is enabled
	const env = loadDotenv(dotenvConfig, configDir);

	// Phase 3: If dotenv is enabled, scan all KDL files and validate env references
	if (dotenvConfig?.enabled) {
		await validateStartupEnv(configDir, serverKdlText, env);
	}

	// Phase 4: Parse configs with env map
	const server = parseServerConfig(serverKdlText, env);

	let channels: ChannelsConfig = {};
	try {
		channels = parseChannelsConfig(await Bun.file(path.join(configDir, "channels.kdl")).text(), configDir, env);
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
		env,
	});

	return { server, channels, manifest, actionRegistry };
}

// -- Dotenv loading --

function loadDotenv(config: DotenvConfig | null, configDir: string): Record<string, string | undefined> {
	if (!config?.enabled) {
		return process.env;
	}

	const envFilePath = path.resolve(configDir, config.path);
	const envVars = parseEnvFile(envFilePath);
	const loadedCount = Object.keys(envVars).length;

	// Inject into process.env (do not overwrite existing values)
	for (const [key, value] of Object.entries(envVars)) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}

	if (loadedCount > 0) {
		console.error(`spell-server: loaded .env from ${envFilePath} (${loadedCount} variables)`);
	} else {
		console.error(`spell-server: dotenv enabled, but no variables found in ${envFilePath}`);
	}

	return process.env;
}

// -- Startup env validation --

const IMPORT_DIRECTIVE_PATTERN = /^import\s+"([^"]+)"/gm;

async function validateStartupEnv(
	configDir: string,
	serverKdlText: string,
	env: Record<string, string | undefined>,
): Promise<void> {
	// Collect env() references from all KDL config files
	const allRefs: EnvReferenceInfo[] = [];

	// server.kdl (already loaded)
	allRefs.push(...scanEnvReferences(serverKdlText, "server.kdl"));

	// channels.kdl (optional)
	try {
		const channelsText = await Bun.file(path.join(configDir, "channels.kdl")).text();
		allRefs.push(...scanEnvReferences(channelsText, "channels.kdl"));
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	// autonomy.kdl + imported files
	try {
		const autonomyText = await Bun.file(path.join(configDir, "autonomy.kdl")).text();
		allRefs.push(...scanEnvReferences(autonomyText, "autonomy.kdl"));

		// Follow import directives (one level)
		for (const match of autonomyText.matchAll(IMPORT_DIRECTIVE_PATTERN)) {
			const importPath = match[1];
			const resolvedPath = path.resolve(configDir, importPath);
			try {
				const importedText = await Bun.file(resolvedPath).text();
				allRefs.push(...scanEnvReferences(importedText, path.basename(importPath)));
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		}
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	if (allRefs.length === 0) return;

	// Validate
	const result = validateEnvReferences(allRefs, env);

	if (result.missing.length > 0) {
		const envFilePath = path.resolve(configDir, ".env");
		const report = formatEnvReport(result, envFilePath);
		console.error(report);
		throw new Error(
			`Missing ${result.missing.length} required environment variable${result.missing.length > 1 ? "s" : ""}. ` +
				`See above for details, or add them to ${envFilePath}`,
		);
	}

	// All resolved — brief success message
	const total = result.loaded.length + result.defaulted.length;
	console.error(`spell-server: all ${total} env references resolved`);
}

// -- Helpers --

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
