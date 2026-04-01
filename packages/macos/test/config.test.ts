import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, getMacOSConfigPath, loadConfig } from "../src/config";

describe("loadConfig", () => {
	it("returns defaults when config file is missing", async () => {
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-macos-config-"));
		const configPath = getMacOSConfigPath(homeDir);
		expect(await loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
	});

	it("deep-merges partial hotkey config", async () => {
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-macos-config-"));
		const configPath = getMacOSConfigPath(homeDir);
		await Bun.write(configPath, JSON.stringify({ overviewHotkey: { key: "p" } }));
		await expect(loadConfig(configPath)).resolves.toEqual({
			pollIntervalMs: DEFAULT_CONFIG.pollIntervalMs,
			overviewHotkey: {
				key: "p",
				modifiers: DEFAULT_CONFIG.overviewHotkey.modifiers,
			},
		});
	});
});
