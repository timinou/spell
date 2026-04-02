import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseChannelsConfig, resolveChannelsBotToken } from "../../src/config/channels-parser";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
});

describe("parseChannelsConfig", () => {
	it("returns an empty config when no telegram node is present", () => {
		expect(parseChannelsConfig("notifications {}\n")).toEqual({});
	});

	it("applies merged telegram defaults for minimal valid KDL", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
		}`);

		expect(config).toEqual({
			telegram: {
				botToken: "123456:ABC-DEF",
				owners: [12345],
				uploadDir: "/tmp/spell-telegram-uploads",
				idleTimeout: 300,
				maxSessions: 10,
				logViewerPort: undefined,
				defaultModel: "claude-sonnet-4-5",
				defaultProject: undefined,
				projects: {},
				users: {},
			},
		});
	});

	it("parses bot-token-file as a deferred file reference", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token-file "secrets/bot-token.txt"
			default-model "claude-sonnet-4-5"
			owners 12345
		}`);

		expect(config.telegram?.botToken).toBe("file:secrets/bot-token.txt");
	});

	it("resolves relative project paths and infers the first project as default", () => {
		const configDir = path.join("/tmp", "spell-config");
		const config = parseChannelsConfig(
			`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				project "spell" "../spell"
				project "docs" "./docs"
			}`,
			configDir,
		);

		expect(config.telegram?.projects).toEqual({
			spell: path.resolve(configDir, "../spell"),
			docs: path.resolve(configDir, "./docs"),
		});
		expect(config.telegram?.defaultProject).toBe("spell");
	});

	it("honors an explicit default-project when project nodes are present", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			default-project "docs"
			project "spell" "/tmp/spell"
			project "docs" "/tmp/docs"
		}`);

		expect(config.telegram?.defaultProject).toBe("docs");
	});

	it("parses user blocks with null idle timeout and project scoping", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			user 999 {
				modes "telegram-readonly" "coding"
				default-mode "coding"
				idle-timeout #null
				projects "spell" "docs"
			}
		}`);

		expect(config.telegram?.users).toEqual({
			999: {
				modes: ["telegram-readonly", "coding"],
				defaultMode: "coding",
				idleTimeout: null,
				projects: ["spell", "docs"],
			},
		});
	});

	it("applies default per-user modes when optional fields are omitted", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			user 999 {}
		}`);

		expect(config.telegram?.users).toEqual({
			999: {
				modes: ["telegram-readonly"],
				defaultMode: "telegram-readonly",
				idleTimeout: undefined,
				projects: undefined,
			},
		});
	});

	it("rejects bot-token and bot-token-file together", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				bot-token-file "bot-token.txt"
				default-model "claude-sonnet-4-5"
				owners 12345
			}`),
		).toThrow("channels.telegram: bot-token and bot-token-file are mutually exclusive");
	});
});

describe("resolveChannelsBotToken", () => {
	it("loads a bot token from a relative bot-token-file path", async () => {
		const configDir = await createTempDir();
		await Bun.write(path.join(configDir, "secrets", "bot-token.txt"), "  123456:ABC-DEF  \n");

		const parsed = parseChannelsConfig(
			`telegram {
				bot-token-file "secrets/bot-token.txt"
				default-model "claude-sonnet-4-5"
				owners 12345
			}`,
			configDir,
		);
		const resolved = await resolveChannelsBotToken(parsed, configDir);

		expect(resolved.telegram?.botToken).toBe("123456:ABC-DEF");
	});

	it("reports a missing bot token file", async () => {
		const configDir = await createTempDir();
		const parsed = parseChannelsConfig(
			`telegram {
				bot-token-file "missing-token.txt"
				default-model "claude-sonnet-4-5"
				owners 12345
			}`,
			configDir,
		);

		await expect(resolveChannelsBotToken(parsed, configDir)).rejects.toThrow(
			`Bot token file not found: ${path.join(configDir, "missing-token.txt")}`,
		);
	});

	it("rejects an empty bot token file", async () => {
		const configDir = await createTempDir();
		await Bun.write(path.join(configDir, "empty-token.txt"), "  \n");
		const parsed = parseChannelsConfig(
			`telegram {
				bot-token-file "empty-token.txt"
				default-model "claude-sonnet-4-5"
				owners 12345
			}`,
			configDir,
		);

		await expect(resolveChannelsBotToken(parsed, configDir)).rejects.toThrow(
			`Bot token file is empty: ${path.join(configDir, "empty-token.txt")}`,
		);
	});
});

async function createTempDir(): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-channels-parser-"));
	tempDirs.add(tempDir);
	return tempDir;
}
