import { describe, expect, it } from "bun:test";
import { parseDotenvConfig, parseServerConfig } from "../../src/config/server-parser";

describe("parseDotenvConfig", () => {
	it("parses dotenv true with default path", () => {
		expect(parseDotenvConfig("dotenv true")).toEqual({ enabled: true, path: ".env" });
	});

	it("parses dotenv path string", () => {
		expect(parseDotenvConfig('dotenv "./secrets/.env"')).toEqual({ enabled: true, path: "./secrets/.env" });
	});

	it("parses dotenv false with default path", () => {
		expect(parseDotenvConfig("dotenv false")).toEqual({ enabled: false, path: ".env" });
	});

	it("returns null when dotenv node is absent", () => {
		expect(parseDotenvConfig("http {\n  port 8787\n}")).toBeNull();
	});
});

describe("parseServerConfig env support", () => {
	const baseServerKdl = `http {
		port "env(PORT, type=number)"
		auth {
			username "spell"
			password "env(PASSWORD)"
		}
		webhook-secret "env(SECRET)"
		goal-token "env(GOAL_NAME, default=default-goal)" "env(TOKEN)"
	}`;

	it("resolves env() values from the provided env map", () => {
		const config = parseServerConfig(baseServerKdl, {
			PORT: "8787",
			PASSWORD: "hunter2", // pragma: allowlist secret
			SECRET: "webhook-secret-value", // pragma: allowlist secret
			TOKEN: "goal-token-value",
			GOAL_NAME: "deploy",
		});

		expect(config).toEqual({
			http: {
				port: 8787,
				auth: {
					username: "spell",
					password: "hunter2", // pragma: allowlist secret
				},
				webhookSecret: "webhook-secret-value", // pragma: allowlist secret
				goalTokens: {
					deploy: "goal-token-value",
				},
			},
		});
	});

	it("throws when a required env var is missing", () => {
		expect(() =>
			parseServerConfig(baseServerKdl, {
				PORT: "8787",
				PASSWORD: "hunter2", // pragma: allowlist secret
				TOKEN: "goal-token-value",
				GOAL_NAME: "deploy",
			}),
		).toThrow("SECRET");
	});

	it("uses env defaults when provided", () => {
		const config = parseServerConfig(
			`http {
				port "env(PORT, type=number, default=3000)"
				auth {
					username "spell"
					password "env(PASSWORD, default=fallback-password)"
				}
				goal-token "env(GOAL_NAME, default=fallback-goal)" "env(TOKEN, default=fallback-token)"
			}`,
			{},
		);

		expect(config).toEqual({
			http: {
				port: 3000,
				auth: {
					username: "spell",
					password: "fallback-password", // pragma: allowlist secret
				},
				webhookSecret: undefined,
				goalTokens: {
					"fallback-goal": "fallback-token",
				},
			},
		});
	});

	it("still accepts literal values without an env map", () => {
		const config = parseServerConfig(`http {
			port 8080
			auth {
				username "spell"
			password "literal-password" // pragma: allowlist secret
			}
			webhook-secret "literal-secret" // pragma: allowlist secret
			goal-token "deploy" "literal-token"
		}`);

		expect(config).toEqual({
			http: {
				port: 8080,
				auth: {
					username: "spell",
					password: "literal-password", // pragma: allowlist secret
				},
				webhookSecret: "literal-secret", // pragma: allowlist secret
				goalTokens: {
					deploy: "literal-token",
				},
			},
		});
	});
});
