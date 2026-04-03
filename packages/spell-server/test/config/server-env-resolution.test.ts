import { describe, expect, it } from "bun:test";
import { parseServerConfig } from "../../src/config/server-parser";

describe("parseServerConfig secret env resolution", () => {
	it("resolves auth.password from the provided env map", () => {
		const config = parseServerConfig(
			`http {
				port 8787
				auth {
					username "spell"
					password "env(MY_PASS)"
				}
			}`,
			{ MY_PASS: "secret123" }, // pragma: allowlist secret
		);

		expect(config.http.auth.password).toBe("secret123"); // pragma: allowlist secret
	});

	it("resolves webhook-secret from the provided env map", () => {
		const config = parseServerConfig(
			`http {
				port 8787
				auth {
					username "spell"
					password "literal-password"
				}
				webhook-secret "env(WH_SECRET)"
			}`,
			{ WH_SECRET: "webhook-secret-value" }, // pragma: allowlist secret
		);

		expect(config.http.webhookSecret).toBe("webhook-secret-value"); // pragma: allowlist secret
	});

	it("throws when auth.password references a missing env var", () => {
		expect(() =>
			parseServerConfig(`http {
				port 8787
				auth {
					username "spell"
					password "env(MY_PASS)"
				}
			}`),
		).toThrow("MY_PASS");
	});

	it("uses the default value for webhook-secret when provided", () => {
		const config = parseServerConfig(`http {
			port 8787
			auth {
				username "spell"
				password "literal-password"
			}
			webhook-secret "env(WH_SECRET, default=fallback)"
		}`);

		expect(config.http.webhookSecret).toBe("fallback"); // pragma: allowlist secret
	});

	it("resolves goal-token name and value env() references from the provided env map", () => {
		const config = parseServerConfig(
			`http {
				port 8787
				auth {
					username "spell"
					password "literal-password"
				}
				goal-token "env(GOAL_NAME, default=export-goal)" "env(GOAL_TOKEN)"
			}`,
			{
				GOAL_NAME: "approval-webhook-goal",
				GOAL_TOKEN: "goal-secret-value",
			}, // pragma: allowlist secret
		);

		expect(config.http.goalTokens).toEqual({
			"approval-webhook-goal": "goal-secret-value",
		});
	});
});
