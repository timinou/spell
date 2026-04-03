import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { parseSyncConfig } from "./sync-parser";
import type { SyncConfig } from "./types";

export async function loadSyncConfig(projectDir: string): Promise<SyncConfig> {
	const configPath = path.join(projectDir, ".spell", "sync.kdl");
	try {
		const text = await Bun.file(configPath).text();
		return parseSyncConfig(text);
	} catch (err: unknown) {
		if (isEnoent(err)) {
			throw new Error(`No sync.kdl found at ${configPath}. Run 'spell deploy init' to create one.`);
		}
		throw err;
	}
}
