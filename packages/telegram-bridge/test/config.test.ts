import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadConfig } from "../src/config/loader";

const FIXTURES = path.join(import.meta.dir, "fixtures");

describe("loadConfig", () => {
	it("loads valid yaml config with all fields", async () => {
		const config = await loadConfig(path.join(FIXTURES, "valid-config.yaml"));

		expect(config.botToken).toBe("1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ");
		expect(config.uploadDir).toBe("/tmp/test-uploads");
		expect(config.logViewerPort).toBe(8080);
		expect(config.idleTimeout).toBe(1800);
		expect(config.maxSessions).toBe(2);
		expect(config.defaultProject).toBe("spell");
	});

	it("resolves project paths as absolute", async () => {
		const config = await loadConfig(path.join(FIXTURES, "valid-config.yaml"));

		expect(path.isAbsolute(config.projects.spell)).toBe(true);
		expect(config.projects.spell).toBe("/home/user/code/ora/spell");
		expect(config.projects.infra).toBe("/home/user/code/infra");
	});

	it("parses user configs with correct types", async () => {
		const config = await loadConfig(path.join(FIXTURES, "valid-config.yaml"));

		// User IDs are coerced to strings
		expect(config.users["123456789"]).toBeDefined();
		expect(config.users["123456789"].modes).toEqual(["telegram-readonly", "telegram-full"]);
		expect(config.users["123456789"].defaultMode).toBe("telegram-readonly");
		expect(config.users["123456789"].idleTimeout).toBeNull();

		expect(config.users["987654321"]).toBeDefined();
		expect(config.users["987654321"].idleTimeout).toBe(600);
		expect(config.users["987654321"].projects).toEqual(["spell"]);
	});

	it("errors with clear message when bot_token_file is missing", async () => {
		await expect(loadConfig(path.join(FIXTURES, "invalid-config.yaml"))).rejects.toThrow(
			"Config missing required field: bot_token_file",
		);
	});

	it("errors when config file does not exist", async () => {
		await expect(loadConfig("/nonexistent/telegram.yaml")).rejects.toThrow("Config file not found");
	});

	it("errors when bot token file does not exist", async () => {
		// Create a temp config pointing to a nonexistent token file
		const tmpDir = path.join(FIXTURES, ".tmp-test");
		await Bun.write(path.join(tmpDir, "bad-token-ref.yaml"), "bot_token_file: ./nonexistent-token.txt\n");
		await expect(loadConfig(path.join(tmpDir, "bad-token-ref.yaml"))).rejects.toThrow("Bot token file not found");
	});

	it("merges defaults for missing optional fields", async () => {
		// Config with only required fields
		const tmpDir = path.join(FIXTURES, ".tmp-test");
		await Bun.write(path.join(tmpDir, "minimal.yaml"), `bot_token_file: ../bot-token.txt\n`);
		const config = await loadConfig(path.join(tmpDir, "minimal.yaml"));

		expect(config.idleTimeout).toBe(3600);
		expect(config.maxSessions).toBe(3);
		expect(config.uploadDir).toBe("/tmp/telegram-uploads");
		expect(config.logViewerPort).toBeUndefined();
	});
});
