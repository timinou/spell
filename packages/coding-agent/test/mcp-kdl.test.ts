/**
 * End-to-end: MCP server config sourced from spell.kdl.
 *
 * Covers WAVE 2.5 of PLAN-311:
 *   - spell.kdl `mcp { server ... }` block round-trips through Settings
 *   - Per-tier merge (user + project + local) — no array-replace collapse
 *   - Migrator translates legacy mcp.json {mcpServers:{...}} into the block
 *   - Pre-existing spell.kdl entries are NOT clobbered (manual edits win)
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Snowflake } from "@oh-my-pi/pi-utils";

let tmp: string;
let agentDir: string;
let projectDir: string;
let userKdl: string;
let projectKdl: string;
let localKdl: string;

function opts() {
	return { cwd: projectDir, agentDir, userKdlPath: userKdl, projectKdlPath: projectKdl, localKdlPath: localKdl };
}

beforeEach(() => {
	_resetSettingsForTest();
	tmp = path.join(os.tmpdir(), "mcp-kdl", Snowflake.next());
	agentDir = path.join(tmp, ".spell", "agent");
	projectDir = path.join(tmp, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	userKdl = path.join(tmp, "user-config", "spell.kdl");
	projectKdl = path.join(projectDir, "spell.kdl");
	localKdl = path.join(projectDir, ".local", "spell.kdl");
});

afterEach(() => {
	if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true });
});

describe("mcp.servers ← spell.kdl", () => {
	it("Settings round-trip preserves stdio + http server shapes", async () => {
		const s = await Settings.init(opts());
		s.set(
			"mcp.servers" as never,
			{
				memory: {
					type: "stdio",
					command: "mcp-memory",
					args: ["--db", "./memory.db"],
					env: { FOO: "bar" },
				},
				exa: {
					type: "http",
					url: "https://mcp.exa.ai/sse?key=abc",
					headers: { "X-Hdr": "v" },
					timeout: 30,
					enabled: true,
				},
			} as never,
		);
		await s.flush();

		_resetSettingsForTest();
		const s2 = await Settings.init(opts());
		const got = s2.get("mcp.servers" as never) as Record<string, Record<string, unknown>>;
		expect(got.memory).toMatchObject({
			type: "stdio",
			command: "mcp-memory",
			args: ["--db", "./memory.db"],
			env: { FOO: "bar" },
		});
		expect(got.exa).toMatchObject({
			type: "http",
			url: "https://mcp.exa.ai/sse?key=abc",
			headers: { "X-Hdr": "v" },
			timeout: 30,
			enabled: true,
		});
	});

	it("auth + oauth properties round-trip", async () => {
		const s = await Settings.init(opts());
		s.set(
			"mcp.servers" as never,
			{
				github: {
					type: "stdio",
					command: "mcp-github",
					auth: { type: "oauth", credentialId: "github-token" },
					oauth: { clientId: "abc", callbackPort: 8765 },
				},
			} as never,
		);
		await s.flush();

		_resetSettingsForTest();
		const s2 = await Settings.init(opts());
		const got = s2.get("mcp.servers" as never) as Record<string, Record<string, unknown>>;
		expect(got.github.auth).toMatchObject({ type: "oauth", credentialId: "github-token" });
		expect(got.github.oauth).toMatchObject({ clientId: "abc", callbackPort: 8765 });
	});

	it("unknown nodes inside mcp block are ignored (with warning)", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(
			userKdl,
			'mcp {\n  unrecognized "ignored"\n  server "ok" type="stdio" {\n    command "x"\n  }\n}\n',
		);
		const s = await Settings.init(opts());
		const got = s.get("mcp.servers" as never) as Record<string, unknown>;
		expect(got).toHaveProperty("ok");
		expect(got).not.toHaveProperty("unrecognized");
	});
});

describe("GATE 2.5 regressions", () => {
	it("[P1] same-name cross-tier: project-tier wins over user-tier", async () => {
		// Force capability registration by importing discovery providers.
		await import("@oh-my-pi/pi-coding-agent/discovery/builtin");
		const { reset: resetCapabilityCache, loadCapability } = await import(
			"@oh-my-pi/pi-coding-agent/discovery"
		);
		const { mcpCapability } = await import("@oh-my-pi/pi-coding-agent/capability/mcp");

		const s = await Settings.init(opts());
		s.set("mcp.servers" as never, { shared: { type: "stdio", command: "user-version" } } as never, "user");
		s.set("mcp.servers" as never, { shared: { type: "stdio", command: "project-version" } } as never, "project");
		await s.flush();

		// Reload to ensure file-read path runs.
		_resetSettingsForTest();
		await Settings.init(opts());

		resetCapabilityCache?.();
		const result = await loadCapability(mcpCapability.id, { cwd: projectDir });
		const entries = result.items as Array<{ name: string; command?: string; _source?: { level?: string } }>;
		const shared = entries.find(e => e.name === "shared");
		expect(shared).toBeDefined();
		expect(shared?.command).toBe("project-version");
		expect(shared?._source?.level).toBe("project");

		const warnings = result.warnings ?? [];
		expect(warnings.some(w => /shared.*user-tier.*project-tier/.test(w))).toBe(true);
	});
});

describe("MCP per-tier additive merge", () => {
	it("user-tier + project-tier servers BOTH apply (different names)", async () => {
		const s = await Settings.init(opts());
		s.set("mcp.servers" as never, { user_srv: { type: "stdio", command: "u" } } as never, "user");
		s.set("mcp.servers" as never, { proj_srv: { type: "stdio", command: "p" } } as never, "project");
		await s.flush();

		// The capability provider in builtin.ts is the consumer; verify via
		// the lower-level Settings.getPerTier which is what the provider uses.
		const tiers = s.getPerTier("mcp.servers" as never);
		expect((tiers.user as Record<string, unknown>).user_srv).toBeDefined();
		expect((tiers.project as Record<string, unknown>).proj_srv).toBeDefined();
	});
});

describe("Migrator: legacy mcp.json → spell.kdl", () => {
	it("translates user-level mcp.json into the mcp block (extracts mcpServers)", async () => {
		const legacy = path.join(agentDir, "mcp.json");
		fs.writeFileSync(
			legacy,
			JSON.stringify({
				mcpServers: {
					memory: { type: "stdio", command: "mcp-memory" },
					exa: { type: "http", url: "https://mcp.exa.ai/sse" },
				},
			}),
		);

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("mcp.servers" as never) as Record<string, Record<string, unknown>>;
		expect(got.memory).toMatchObject({ type: "stdio", command: "mcp-memory" });
		expect(got.exa).toMatchObject({ type: "http", url: "https://mcp.exa.ai/sse" });
		expect(fs.existsSync(legacy)).toBe(false);
	});

	it("translates project-level mcp.json into project spell.kdl", async () => {
		const legacy = path.join(projectDir, ".spell", "mcp.json");
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { proj: { type: "stdio", command: "p" } } }));

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const tiers = s.getPerTier("mcp.servers" as never);
		expect((tiers.project as Record<string, unknown>).proj).toBeDefined();
		expect(tiers.user).toBeUndefined();
	});

	it("merges legacy mcp.json with pre-existing spell.kdl mcp block (manual edits win)", async () => {
		// Pre-existing manual edit in user spell.kdl.
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(
			userKdl,
			'mcp {\n  server "manual" type="stdio" {\n    command "manual-cmd"\n  }\n  server "shared" type="stdio" {\n    command "spellkdl-version"\n  }\n}\n',
		);

		// Legacy mcp.json with overlapping `shared` and a new `legacy-only`.
		const legacy = path.join(agentDir, "mcp.json");
		fs.writeFileSync(
			legacy,
			JSON.stringify({
				mcpServers: {
					shared: { type: "stdio", command: "mcp-json-version" },
					"legacy-only": { type: "stdio", command: "legacy-cmd" },
				},
			}),
		);

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("mcp.servers" as never) as Record<string, Record<string, unknown>>;
		// All three appear; the SHARED server keeps the manual spell.kdl version.
		expect(got.manual).toMatchObject({ command: "manual-cmd" });
		expect(got["legacy-only"]).toMatchObject({ command: "legacy-cmd" });
		expect(got.shared.command).toBe("spellkdl-version");
	});

	it("idempotent: re-running after migration is a no-op", async () => {
		const legacy = path.join(agentDir, "mcp.json");
		fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { x: { type: "stdio", command: "x" } } }));
		await Settings.init({ ...opts(), migrate: { yes: true } });

		_resetSettingsForTest();
		const s2 = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s2.get("mcp.servers" as never) as Record<string, Record<string, unknown>>;
		expect(got.x).toBeDefined();
	});
});
