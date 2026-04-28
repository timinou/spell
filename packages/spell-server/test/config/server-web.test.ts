import { describe, expect, it } from "bun:test";
import { parseServerConfig } from "../../src/config/server-parser";

const baseHttp = `http {
	port 8787
	auth {
		username "spell"
		password "hunter2"
	}
}`;

function configWithWeb(webBlock: string): string {
	return `${baseHttp}\n${webBlock}`;
}

describe("parseServerConfig web block", () => {
	it("returns undefined when web block is omitted", () => {
		const config = parseServerConfig(baseHttp);
		expect(config.web).toBeUndefined();
	});

	it("parses literal token entries", () => {
		const kdl = configWithWeb(`web {
			token "alice" "secret-a"
			token "bob" "secret-b"
		}`);
		const config = parseServerConfig(kdl);
		expect(config.web).toBeDefined();
		expect(config.web?.tokens.size).toBe(2);
		expect(config.web?.tokens.get("alice")).toBe("secret-a");
		expect(config.web?.tokens.get("bob")).toBe("secret-b");
	});

	it("resolves env() token references against the env map", () => {
		const kdl = configWithWeb(`web {
			token "alice" "env(WEB_TOKEN_A)"
		}`);
		const config = parseServerConfig(kdl, { WEB_TOKEN_A: "xyz" });
		expect(config.web?.tokens.get("alice")).toBe("xyz");
	});

	it("throws with field path when required env var is missing", () => {
		const kdl = configWithWeb(`web {
			token "alice" "env(WEB_TOKEN_A)"
		}`);
		expect(() => parseServerConfig(kdl, {})).toThrow(/web\.tokens\.alice|WEB_TOKEN_A/);
	});

	it("returns empty token map when web block is empty", () => {
		const kdl = configWithWeb("web {}");
		const config = parseServerConfig(kdl);
		expect(config.web).toBeDefined();
		expect(config.web?.tokens.size).toBe(0);
	});

	it("rejects duplicate token names", () => {
		const kdl = configWithWeb(`web {
			token "alice" "x"
			token "alice" "y"
		}`);
		expect(() => parseServerConfig(kdl)).toThrow(/duplicate.*alice/i);
	});

	it("rejects empty post-resolution secret", () => {
		const kdl = configWithWeb(`web {
			token "alice" ""
		}`);
		expect(() => parseServerConfig(kdl)).toThrow(/non-empty|empty/);
	});

	it("skips optional env tokens whose variable is unset", () => {
		const kdl = configWithWeb(`web {
			token "alice" "secret-a"
			token "ghost" "env(MISSING, optional)"
		}`);
		const config = parseServerConfig(kdl, {});
		expect(config.web?.tokens.size).toBe(1);
		expect(config.web?.tokens.get("alice")).toBe("secret-a");
		expect(config.web?.tokens.has("ghost")).toBe(false);
	});
});
