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
				autoSendImages: true,
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

	it("defaults autoSendImages to true", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
		}`);
		expect(config.telegram?.autoSendImages).toBe(true);
	});

	it("parses auto-send-images false", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			auto-send-images #false
		}`);
		expect(config.telegram?.autoSendImages).toBe(false);
	});

	it("parses auto-send-images true", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			auto-send-images #true
		}`);
		expect(config.telegram?.autoSendImages).toBe(true);
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

	it("rejects non-boolean auto-send-images value", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				auto-send-images "yes"
			}`),
		).toThrow(/must be a boolean/i);
	});

	it("resolves env(NAME) in bot-token", () => {
		const config = parseChannelsConfig(
			`telegram {
				bot-token "env(TELEGRAM_BOT_TOKEN)"
				default-model "claude-sonnet-4-5"
				owners 12345
			}`,
			undefined,
			{ TELEGRAM_BOT_TOKEN: "123456:ENV-ABC" },
		);

		expect(config.telegram?.botToken).toBe("123456:ENV-ABC");
	});

	it("resolves env(NAME) in upload-dir", () => {
		const config = parseChannelsConfig(
			`telegram {
				bot-token "123456:ABC-DEF"
				upload-dir "env(TELEGRAM_UPLOAD_DIR)"
				default-model "claude-sonnet-4-5"
				owners 12345
			}`,
			undefined,
			{ TELEGRAM_UPLOAD_DIR: "/var/spell/uploads" },
		);

		expect(config.telegram?.uploadDir).toBe("/var/spell/uploads");
	});

	it("resolves env(NAME) in default-model and default-project", () => {
		const config = parseChannelsConfig(
			`telegram {
				bot-token "123456:ABC-DEF"
				default-model "env(TELEGRAM_DEFAULT_MODEL)"
				default-project "env(TELEGRAM_DEFAULT_PROJECT)"
				owners 12345
				project "spell" "/tmp/spell"
				project "docs" "/tmp/docs"
			}`,
			undefined,
			{
				TELEGRAM_DEFAULT_MODEL: "gpt-4.1-mini",
				TELEGRAM_DEFAULT_PROJECT: "docs",
			},
		);

		expect(config.telegram?.defaultModel).toBe("gpt-4.1-mini");
		expect(config.telegram?.defaultProject).toBe("docs");
	});

	it("throws when a required env-backed field is missing", () => {
		expect(() =>
			parseChannelsConfig(
				`telegram {
					bot-token "env(TELEGRAM_BOT_TOKEN)"
					default-model "claude-sonnet-4-5"
					owners 12345
				}`,
				undefined,
				{},
			),
		).toThrow("channels.telegram.bot-token requires environment variable TELEGRAM_BOT_TOKEN");
	});

	it("keeps literal string fields working without an env map", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			upload-dir "/tmp/literal-uploads"
			default-model "claude-sonnet-4-5"
			default-project "spell"
			owners 12345
			project "spell" "/tmp/spell"
		}`);

		expect(config.telegram?.botToken).toBe("123456:ABC-DEF");
		expect(config.telegram?.uploadDir).toBe("/tmp/literal-uploads");
		expect(config.telegram?.defaultModel).toBe("claude-sonnet-4-5");
		expect(config.telegram?.defaultProject).toBe("spell");
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

describe("parseSessionNotifications", () => {
	it("parses session-notifications with empty renderers by default", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				notify-owners #true
			}
		}`);

		expect(config.telegram?.sessionNotifications?.renderers).toEqual([]);
	});

	it("parses a single renderer with all attributes", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				notify-owners #true
				renderer "pdf" {
					command "bash" "render/typst-render.sh"
					mime "application/pdf"
					extension "pdf"
					timeout-ms 20000
					cache-by "transcript-hash"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.renderers).toEqual([{
			id: "pdf",
			command: "bash",
			args: ["render/typst-render.sh"],
			mime: "application/pdf",
			extension: "pdf",
			timeoutMs: 20000,
			cacheBy: "transcript-hash",
		}]);
	});

	it("applies default timeout-ms=20000 when omitted", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.renderers[0]?.timeoutMs).toBe(20000);
	});

	it("applies default cache-by='transcript-hash' when omitted", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.renderers[0]?.cacheBy).toBe("transcript-hash");
	});

	it("parses two renderers with distinct ids", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				renderer "pdf" {
					command "bash" "render/typst.sh"
					mime "application/pdf"
					extension "pdf"
				}
				renderer "html" {
					command "node" "render/html.js"
					mime "text/html"
					extension "html"
					cache-by "none"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.renderers).toHaveLength(2);
		expect(config.telegram?.sessionNotifications?.renderers[0]).toEqual({
			id: "pdf",
			command: "bash",
			args: ["render/typst.sh"],
			mime: "application/pdf",
			extension: "pdf",
			timeoutMs: 20000,
			cacheBy: "transcript-hash",
		});
		expect(config.telegram?.sessionNotifications?.renderers[1]).toEqual({
			id: "html",
			command: "node",
			args: ["render/html.js"],
			mime: "text/html",
			extension: "html",
			timeoutMs: 20000,
			cacheBy: "none",
		});
	});

	it("rejects two renderers with duplicate id", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render1.sh"
						mime "application/pdf"
						extension "pdf"
					}
					renderer "pdf" {
						command "bash" "render2.sh"
						mime "application/pdf"
						extension "pdf"
					}
				}
			}`)
		).toThrow(/duplicate renderer id "pdf"/);
	});

	it("rejects missing command field", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						mime "application/pdf"
						extension "pdf"
					}
				}
			}`)
		).toThrow(/command is required/);
	});

	it("rejects empty command args", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command
						mime "application/pdf"
						extension "pdf"
					}
				}
			}`)
		).toThrow(/command must have at least one string argument/);
	});

	it("rejects unknown child node in renderer", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
						unknown-field "value"
					}
				}
			}`)
		).toThrow(/unknown-field is not supported/);
	});

	it("rejects negative timeout-ms", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
						timeout-ms -1000
					}
				}
			}`)
		).toThrow(/timeout-ms must be a positive number/);
	});

	it("rejects zero timeout-ms", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
						timeout-ms 0
					}
				}
			}`)
		).toThrow(/timeout-ms must be a positive number/);
	});

	it("rejects invalid cache-by value", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
						cache-by "invalid"
					}
				}
			}`)
		).toThrow(/cache-by must be "transcript-hash" or "none"/);
	});

	it("accepts cache-by 'none'", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
					cache-by "none"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.renderers[0]?.cacheBy).toBe("none");
	});

	it("rejects renderer with empty id", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
					}
				}
			}`)
		).toThrow(/renderer must have a non-empty string id argument/);
	});

	it("rejects missing mime field", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						extension "pdf"
					}
				}
			}`)
		).toThrow(/mime is required/);
	});

	it("rejects missing extension field", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
					}
				}
			}`)
		).toThrow(/extension is required/);
	});

	it("parses multiple command args", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				renderer "pdf" {
					command "python" "render.py" "--format" "pdf"
					mime "application/pdf"
					extension "pdf"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.renderers[0]).toEqual({
			id: "pdf",
			command: "python",
			args: ["render.py", "--format", "pdf"],
			mime: "application/pdf",
			extension: "pdf",
			timeoutMs: 20000,
			cacheBy: "transcript-hash",
		});
	});
});

describe("parseChannelsConfig attach blocks", () => {
	it("parses single attach block with full transcript", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval" "ask"
				notify-owners #true
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
				attach renderer="pdf" {
					transcript "full"
					on "plan_approval"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.attaches).toEqual([{
			rendererId: "pdf",
			transcript: "full",
			on: ["plan_approval"],
		}]);
	});

	it("parses attach with last-turn transcript", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "ask"
				notify-owners #true
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
				attach renderer="pdf" {
					transcript "last-turn"
					on "ask"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.attaches?.[0]).toEqual({
			rendererId: "pdf",
			transcript: "last-turn",
			on: ["ask"],
		});
	});

	it("parses multiple attach blocks", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval" "ask"
				notify-owners #true
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
				renderer "markdown" {
					command "cat"
					mime "text/markdown"
					extension "md"
				}
				attach renderer="pdf" {
					transcript "full"
					on "plan_approval"
				}
				attach renderer="markdown" {
					transcript "last-turn"
					on "ask"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.attaches).toHaveLength(2);
		expect(config.telegram?.sessionNotifications?.attaches?.[0]?.rendererId).toBe("pdf");
		expect(config.telegram?.sessionNotifications?.attaches?.[1]?.rendererId).toBe("markdown");
	});

	it("throws error on unknown renderer reference in attach", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					notify-owners #true
					attach renderer="unknown" {
						transcript "full"
						on "plan_approval"
					}
				}
			}`)
		).toThrow(/unknown renderer/i);
	});

	it("filters out unknown event kinds from attach on list", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval" "ask" "unknown_event"
				notify-owners #true
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
				attach renderer="pdf" {
					transcript "full"
					on "plan_approval" "unknown_event" "ask"
				}
			}
		}`);

		// Only "plan_approval" and "ask" should remain after filtering
		expect(config.telegram?.sessionNotifications?.attaches?.[0]?.on).toEqual([
			"plan_approval",
			"ask",
		]);
	});

	it("defaults attaches to empty array when not present", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				notify-owners #true
			}
		}`);

		expect(config.telegram?.sessionNotifications?.attaches).toEqual([]);
	});

describe("parseChannelsConfig attach with summarize", () => {
	it("parses attach with summarize block and all attributes", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				notify-owners #true
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
				attach renderer="pdf" {
					transcript "full"
					on "plan_approval"
					summarize {
						when "message-count>30"
						model "gpt-4-mini"
						endpoint "https://api.openai.com/v1/chat/completions"
						api-key "sk-test-key"
						max-tokens 250
						prompt-style "needs-input-recap"
					}
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.attaches?.[0]?.summarize).toEqual({
			when: { kind: "message-count", threshold: 30 },
			model: "gpt-4-mini",
			endpoint: "https://api.openai.com/v1/chat/completions",
			apiKey: "sk-test-key",
			maxTokens: 250,
			promptStyle: "needs-input-recap",
		});
	});

	it("parses attach with byte-count threshold", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				notify-owners #true
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
				attach renderer="pdf" {
					transcript "full"
					on "plan_approval"
					summarize {
						when "byte-count>50000"
						model "gpt-4-mini"
						endpoint "https://api.openai.com/v1"
						api-key "test"
					}
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.attaches?.[0]?.summarize?.when).toEqual({
			kind: "byte-count",
			threshold: 50000,
		});
	});

	it("throws when summarize is missing required model field", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
					}
					attach renderer="pdf" {
						transcript "full"
						on "plan_approval"
						summarize {
							when "message-count>30"
							endpoint "https://api.openai.com"
							api-key "test"
						}
					}
				}
			}`)
		).toThrow(/model is required/);
	});

	it("throws when summarize is missing required endpoint field", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
					}
					attach renderer="pdf" {
						transcript "full"
						on "plan_approval"
						summarize {
							when "message-count>30"
							model "gpt-4"
							api-key "test"
						}
					}
				}
			}`)
		).toThrow(/endpoint is required/);
	});

	it("throws when summarize is missing required api-key field", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
					}
					attach renderer="pdf" {
						transcript "full"
						on "plan_approval"
						summarize {
							when "message-count>30"
							model "gpt-4"
							endpoint "https://api.openai.com"
						}
					}
				}
			}`)
		).toThrow(/api-key is required/);
	});

	it("applies default max-tokens=250 when omitted from summarize", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				notify-owners #true
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
				attach renderer="pdf" {
					transcript "full"
					on "plan_approval"
					summarize {
						when "message-count>30"
						model "gpt-4"
						endpoint "https://api.openai.com"
						api-key "test"
					}
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.attaches?.[0]?.summarize?.maxTokens).toBe(250);
	});

	it("resolves env() in summarize api-key field", () => {
		const config = parseChannelsConfig(
			`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
					}
					attach renderer="pdf" {
						transcript "full"
						on "plan_approval"
						summarize {
							when "message-count>30"
							model "gpt-4"
							endpoint "https://api.openai.com"
							api-key "env(OPENAI_API_KEY)"
						}
					}
				}
			}`,
			undefined,
			{ OPENAI_API_KEY: "sk-from-env" },
		);

		expect(config.telegram?.sessionNotifications?.attaches?.[0]?.summarize?.apiKey).toBe(
			"sk-from-env",
		);
	});

	it("throws when summarize when clause has invalid format", () => {
		expect(() =>
			parseChannelsConfig(`telegram {
				bot-token "123456:ABC-DEF"
				default-model "claude-sonnet-4-5"
				owners 12345
				session-notifications {
					events "plan_approval"
					renderer "pdf" {
						command "bash" "render.sh"
						mime "application/pdf"
						extension "pdf"
					}
					attach renderer="pdf" {
						transcript "full"
						on "plan_approval"
						summarize {
							when "invalid-format"
							model "gpt-4"
							endpoint "https://api.openai.com"
							api-key "test"
						}
					}
				}
			}`)
		).toThrow(/must match pattern/);
	});

	it("defaults attach summarize to undefined when not present", () => {
		const config = parseChannelsConfig(`telegram {
			bot-token "123456:ABC-DEF"
			default-model "claude-sonnet-4-5"
			owners 12345
			session-notifications {
				events "plan_approval"
				notify-owners #true
				renderer "pdf" {
					command "bash" "render.sh"
					mime "application/pdf"
					extension "pdf"
				}
				attach renderer="pdf" {
					transcript "full"
					on "plan_approval"
				}
			}
		}`);

		expect(config.telegram?.sessionNotifications?.attaches?.[0]?.summarize).toBeUndefined();
	});
});

});
