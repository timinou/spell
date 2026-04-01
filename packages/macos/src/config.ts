import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

export interface MacOSConfig {
	overviewHotkey: {
		key: string;
		modifiers: string[];
	};
	pollIntervalMs: number;
}

export const DEFAULT_CONFIG: MacOSConfig = {
	overviewHotkey: {
		key: "o",
		modifiers: ["cmd", "alt"],
	},
	pollIntervalMs: 2000,
};

export function getMacOSConfigPath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".spell", "macos-config.json");
}

export async function loadConfig(configPath = getMacOSConfigPath()): Promise<MacOSConfig> {
	try {
		const raw = await Bun.file(configPath).json();
		const data = (raw ?? {}) as Partial<MacOSConfig>;
		return {
			pollIntervalMs: data.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs,
			overviewHotkey: {
				key: data.overviewHotkey?.key ?? DEFAULT_CONFIG.overviewHotkey.key,
				modifiers: data.overviewHotkey?.modifiers ?? DEFAULT_CONFIG.overviewHotkey.modifiers,
			},
		};
	} catch (error) {
		if (isEnoent(error)) return DEFAULT_CONFIG;
		throw error;
	}
}
