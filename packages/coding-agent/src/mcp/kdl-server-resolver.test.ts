/**
 * WAVE 2 (FEAT-828): the `/mcp` command layer must resolve and persist servers
 * declared in spell.kdl (settings `mcp.servers` tiers), not only legacy
 * `mcp.json`. These pure functions carry that logic so it is testable without a
 * live controller/session/filesystem.
 *
 * Invariants pinned here:
 *  - a server declared ONLY in a KDL tier resolves (was "not found" before).
 *  - KDL wins over a same-named legacy mcp.json entry (matches
 *    builtin.ts::loadMCPServers precedence).
 *  - entry <-> config conversion round-trips, including the widened OAuth auth
 *    coordinates from BUG-491 (WAVE 1).
 */

import { describe, expect, it } from "bun:test";

import type { McpServerKdlEntry } from "../config/kdl-compatibility";
import { configToEntry, entryToConfig, resolveMcpServer } from "./kdl-server-resolver";
import type { MCPServerConfig } from "./types";

const notionEntry: McpServerKdlEntry = {
	type: "http",
	url: "https://mcp.notion.com/mcp",
	auth: {
		type: "oauth",
		credentialId: "cred-abc",
		tokenUrl: "https://mcp.notion.com/token",
		clientId: "client-xyz",
	},
};

describe("resolveMcpServer — tier precedence", () => {
	it("resolves a server declared only in the KDL project tier", () => {
		const found = resolveMcpServer("notion", {
			kdl: { user: {}, project: { notion: notionEntry } },
			legacy: { user: {}, project: {} },
		});
		expect(found?.scope).toBe("project");
		expect(found?.entry).toEqual(notionEntry);
	});

	it("resolves a server declared only in the KDL user tier", () => {
		const found = resolveMcpServer("notion", {
			kdl: { user: { notion: notionEntry }, project: {} },
			legacy: { user: {}, project: {} },
		});
		expect(found?.scope).toBe("user");
	});

	it("prefers the project tier over the user tier for the same name", () => {
		const userVariant: McpServerKdlEntry = { type: "http", url: "https://user.example/mcp" };
		const found = resolveMcpServer("notion", {
			kdl: { user: { notion: userVariant }, project: { notion: notionEntry } },
			legacy: { user: {}, project: {} },
		});
		expect(found?.scope).toBe("project");
		expect(found?.entry.url).toBe("https://mcp.notion.com/mcp");
	});

	it("prefers a KDL entry over a same-named legacy mcp.json entry", () => {
		const found = resolveMcpServer("notion", {
			kdl: { user: {}, project: { notion: notionEntry } },
			legacy: { user: {}, project: { notion: { type: "http", url: "https://legacy.example/mcp" } } },
		});
		expect(found?.source).toBe("kdl");
		expect(found?.entry.url).toBe("https://mcp.notion.com/mcp");
	});

	it("falls back to a legacy mcp.json entry when no KDL entry exists", () => {
		const legacyEntry: McpServerKdlEntry = { type: "http", url: "https://legacy.example/mcp" };
		const found = resolveMcpServer("legacyonly", {
			kdl: { user: {}, project: {} },
			legacy: { user: {}, project: { legacyonly: legacyEntry } },
		});
		expect(found?.source).toBe("legacy");
		expect(found?.scope).toBe("project");
	});

	it("returns null when the server is absent everywhere", () => {
		const found = resolveMcpServer("ghost", {
			kdl: { user: {}, project: {} },
			legacy: { user: {}, project: {} },
		});
		expect(found).toBeNull();
	});
});

describe("entryToConfig / configToEntry — round-trip", () => {
	it("converts a KDL entry to a runtime config preserving OAuth auth coordinates", () => {
		const config = entryToConfig(notionEntry);
		expect(config.type).toBe("http");
		expect(config.auth).toEqual({
			type: "oauth",
			credentialId: "cred-abc",
			tokenUrl: "https://mcp.notion.com/token",
			clientId: "client-xyz",
		});
	});

	it("round-trips config -> entry -> config for an http oauth server", () => {
		const config: MCPServerConfig = {
			type: "http",
			url: "https://mcp.notion.com/mcp",
			auth: {
				type: "oauth",
				credentialId: "cred-abc",
				tokenUrl: "https://mcp.notion.com/token",
				clientId: "client-xyz",
				clientSecret: "NOTION_CLIENT_SECRET", // pragma: allowlist secret
			},
		};
		const back = entryToConfig(configToEntry(config));
		expect(back).toEqual(config);
	});

	it("round-trips a stdio server (command + args + env)", () => {
		const config: MCPServerConfig = {
			type: "stdio",
			command: "npx",
			args: ["-y", "@notionhq/notion-mcp-server"],
			env: { NOTION_TOKEN: "TOKEN_ENV" },
		};
		const back = entryToConfig(configToEntry(config));
		expect(back.type).toBe("stdio");
		expect(back).toEqual(config);
	});
});
