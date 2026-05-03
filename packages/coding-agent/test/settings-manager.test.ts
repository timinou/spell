import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { reset as resetCapabilityCache } from "@oh-my-pi/pi-coding-agent/discovery";
import { getProjectAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("Settings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		// Reset global singleton so each test gets a fresh instance
		_resetSettingsForTest();

		// Use snowflake to isolate parallel test runs (SQLite files can't be shared)
		testDir = path.join(os.tmpdir(), "test-settings-tmp", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");

		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	// providers.anthropicStreamIdleTimeoutMs removed in kdl-config cutover — test section deleted
	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	};

	afterEach(() => {
		delete Bun.env.PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS;
		ai.setAnthropicStreamIdleTimeoutOverrideMs(undefined);

		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	// Tests that SettingsManager merges with DB state on save rather than blindly overwriting.
	// This ensures external edits (via AgentStorage directly) aren't lost when the app saves.
	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Seed initial settings in config.yml
			await writeSettings({
				theme: "dark",
				modelRoles: { default: "claude-sonnet" },
			});

			// Settings loads the initial state
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Simulate external edit (e.g., user modifying DB directly or another process)
			await writeSettings({
				theme: { dark: "anthracite" },
				modelRoles: { default: "claude-sonnet" },
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
			});

			// Settings saves a change - should merge, not overwrite
			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
			expect((savedSettings.modelRoles as { default?: string } | undefined)?.default).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
			});

			settings.set("theme.dark", "anthracite");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
		});

		it("should let in-memory changes override file changes for same key", async () => {
			await writeSettings({
				theme: { dark: "anthracite" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				theme: { dark: "anthracite" },
				defaultThinkingLevel: Effort.Low,
			});

			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
		});
	});

	describe("project-level config.yml loading", () => {
		const writeProjectYaml = async (data: Record<string, unknown>) => {
			const yamlDir = path.join(getProjectAgentDir(projectDir), "agent");
			fs.mkdirSync(yamlDir, { recursive: true });
			await Bun.write(path.join(yamlDir, "config.yml"), YAML.stringify(data, null, 2));
		};

		beforeEach(() => {
			// Clear capability FS cache so each test reads fresh files
			resetCapabilityCache();
		});

		it("should load planMode.allowedFolders from project .spell/agent/config.yml", async () => {
			await writeProjectYaml({
				planMode: {
					allowedFolders: { "./specs": "Spec files" },
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("planMode.allowedFolders")).toEqual({ "./specs": "Spec files" });
		});

		it("should merge project YAML with global config without clobbering", async () => {
			// Global config sets theme
			await writeSettings({ theme: { dark: "anthracite" } });
			// Project YAML sets planMode
			await writeProjectYaml({
				planMode: {
					allowedFolders: { "./specs": "Spec files" },
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			// Global setting preserved
			expect(settings.get("theme.dark")).toBe("anthracite");
			// Project YAML setting merged in
			expect(settings.get("planMode.allowedFolders")).toEqual({ "./specs": "Spec files" });
		});

		it("should load from both settings.json and config.yml at project level", async () => {
			// Write project-level settings.json (in .spell/ dir)
			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "settings.json"),
				JSON.stringify({ shellPath: "/bin/zsh" }),
			);
			// Write project-level config.yml (in .spell/agent/ dir)
			await writeProjectYaml({
				planMode: {
					allowedFolders: { "./docs": "Documentation" },
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			// JSON settings.json value present
			expect(settings.get("shellPath")).toBe("/bin/zsh");
			// YAML config.yml value also present
			expect(settings.get("planMode.allowedFolders")).toEqual({ "./docs": "Documentation" });
		});
	});
});
