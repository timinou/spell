/**
 * Unit tests for translate.ts — YAML/JSON/KDL → dest KDL + .bak rename.
 *
 * Self-contained: lives inside the migration directory, deleted with it.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@spell/pi-utils";
import type { Finding } from "../detect";
import { backupSuffix, flattenToSettingsMap, translateFinding } from "../translate";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = path.join(os.tmpdir(), "migration-translate", Snowflake.next());
	fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
	if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true });
});

function srcPath(name: string): string {
	return path.join(tmpRoot, name);
}

function destPath(name = "spell.kdl"): string {
	return path.join(tmpRoot, "dest", name);
}

function makeFinding(source: string, format: Finding["format"], dest: string = destPath()): Finding {
	return { source, format, dest, tier: "user", bytes: fs.statSync(source).size };
}

describe("backupSuffix", () => {
	it("renders as .migrated-YYYY-MM-DD.bak using UTC date", () => {
		const d = new Date(Date.UTC(2026, 4, 21, 12, 0, 0));
		expect(backupSuffix(d)).toBe(".migrated-2026-05-21.bak");
	});
});

describe("flattenToSettingsMap", () => {
	it("extracts known nested paths", () => {
		const obj = { defaultThinkingLevel: "high", theme: { dark: "anthracite" } };
		const map = flattenToSettingsMap(obj);
		expect(map.get("defaultThinkingLevel")).toBe("high");
		expect(map.get("theme.dark")).toBe("anthracite");
	});

	it("accepts flat-key form as well as nested", () => {
		const obj = { "theme.dark": "anthracite" };
		const map = flattenToSettingsMap(obj);
		expect(map.get("theme.dark")).toBe("anthracite");
	});

	it("drops unknown keys silently", () => {
		const obj = { unknownKey: "x", definitelyNotASetting: 42 };
		const map = flattenToSettingsMap(obj);
		expect(map.size).toBe(0);
	});
});

describe("translateFinding: YAML source", () => {
	it("writes dest KDL with extracted settings and renames source to .bak", async () => {
		const source = srcPath("config.yml");
		fs.writeFileSync(source, "defaultThinkingLevel: high\ntheme:\n  dark: anthracite\n");
		const finding = makeFinding(source, "yaml");

		const now = new Date(Date.UTC(2026, 4, 21, 0, 0, 0));
		const result = await translateFinding(finding, now);
		expect(result).not.toBeNull();
		expect(result?.keysWritten).toBe(2);
		expect(result?.bakPath).toBe(source + ".migrated-2026-05-21.bak");

		// Source removed, .bak created
		expect(fs.existsSync(source)).toBe(false);
		expect(fs.existsSync(result!.bakPath)).toBe(true);

		// Dest KDL contains both settings
		const kdl = fs.readFileSync(destPath(), "utf8");
		// defaultThinkingLevel maps to model { thinking ... }
		expect(kdl).toMatch(/model[\s\S]*thinking[\s\S]*high/);
		expect(kdl).toMatch(/anthracite/);
	});

	it("survives same-day collision: picks suffixed .bak path", async () => {
		const source = srcPath("config.yml");
		fs.writeFileSync(source, "defaultThinkingLevel: high\n");
		// Pre-create the would-be .bak target.
		fs.writeFileSync(source + ".migrated-2026-05-21.bak", "old");

		const now = new Date(Date.UTC(2026, 4, 21, 0, 0, 0));
		const result = await translateFinding(makeFinding(source, "yaml"), now);
		expect(result?.bakPath).toBe(source + ".migrated-2026-05-21.1.bak");
	});
});

describe("translateFinding: JSON source", () => {
	it("translates settings.json into dest KDL", async () => {
		const source = srcPath("settings.json");
		fs.writeFileSync(source, JSON.stringify({ defaultThinkingLevel: "low" }));
		const result = await translateFinding(makeFinding(source, "json"));
		expect(result?.keysWritten).toBe(1);
		const kdl = fs.readFileSync(destPath(), "utf8");
		expect(kdl).toMatch(/model[\s\S]*thinking[\s\S]*low/);
	});

	it("returns null on invalid JSON (does NOT rename source)", async () => {
		const source = srcPath("bad.json");
		fs.writeFileSync(source, "{ not valid json");
		const result = await translateFinding(makeFinding(source, "json"));
		expect(result).toBeNull();
		// Source untouched — user can fix and retry.
		expect(fs.existsSync(source)).toBe(true);
	});
});

describe("translateFinding: KDL source (move)", () => {
	it("translates KDL → KDL by copy-then-rename", async () => {
		const source = srcPath("spell.kdl");
		// Source must use the canonical KDL schema, not flat keys.
		fs.writeFileSync(source, 'model {\n  thinking "medium"\n}\n');
		const finding = makeFinding(source, "kdl");
		const result = await translateFinding(finding);
		expect(result?.keysWritten).toBeGreaterThanOrEqual(1);
		expect(fs.existsSync(source)).toBe(false);
		const kdl = fs.readFileSync(destPath(), "utf8");
		expect(kdl).toMatch(/model[\s\S]*thinking[\s\S]*medium/);
	});
});

describe("translateFinding: merge behavior", () => {
	it("merges into existing destination KDL without clobbering unrelated keys", async () => {
		// Pre-existing dest with a different key.
		fs.mkdirSync(path.dirname(destPath()), { recursive: true });
		fs.writeFileSync(destPath(), 'appearance {\n  theme dark="solarized-light"\n}\n');

		const source = srcPath("config.yml");
		fs.writeFileSync(source, "defaultThinkingLevel: high\n");
		await translateFinding(makeFinding(source, "yaml"));

		const kdl = fs.readFileSync(destPath(), "utf8");
		// New key added (defaultThinkingLevel → model.thinking)
		expect(kdl).toMatch(/model[\s\S]*thinking[\s\S]*high/);
		// Existing key preserved
		expect(kdl).toMatch(/solarized-light/);
	});
});

describe("translateFinding: empty source (GATE 1 P2.1)", () => {
	it("renames .bak even when nothing recognizable is found (prevents reprompt)", async () => {
		const source = srcPath("config.yml");
		fs.writeFileSync(source, "totallyUnknownKey: 42\n");
		const result = await translateFinding(makeFinding(source, "yaml"));
		expect(result).not.toBeNull();
		expect(result?.keysWritten).toBe(0);
		expect(fs.existsSync(source)).toBe(false);
		expect(fs.existsSync(result!.bakPath)).toBe(true);
	});

	it("zero-byte YAML file is treated as empty and .bak'd (not retried forever)", async () => {
		const source = srcPath("config.yml");
		fs.writeFileSync(source, "");
		const result = await translateFinding(makeFinding(source, "yaml"));
		expect(result).not.toBeNull();
		expect(fs.existsSync(source)).toBe(false);
		expect(fs.existsSync(result!.bakPath)).toBe(true);
		// No destination file written when there's nothing to write.
		expect(fs.existsSync(destPath())).toBe(false);
	});

	it("zero-byte JSON file is treated as empty and .bak'd", async () => {
		const source = srcPath("settings.json");
		fs.writeFileSync(source, "");
		const result = await translateFinding(makeFinding(source, "json"));
		expect(result).not.toBeNull();
		expect(fs.existsSync(source)).toBe(false);
	});

	it("YAML containing only a comment is treated as empty", async () => {
		const source = srcPath("config.yml");
		fs.writeFileSync(source, "# only a comment\n");
		const result = await translateFinding(makeFinding(source, "yaml"));
		expect(result).not.toBeNull();
		expect(fs.existsSync(source)).toBe(false);
	});

	it("YAML top-level scalar (not a record) is treated as empty", async () => {
		const source = srcPath("config.yml");
		fs.writeFileSync(source, "just-a-string\n");
		const result = await translateFinding(makeFinding(source, "yaml"));
		expect(result).not.toBeNull();
		expect(fs.existsSync(source)).toBe(false);
	});
});

describe("translateFinding: parse error preserves source (GATE 1 P2.1)", () => {
	it("truly broken YAML keeps source untouched (no .bak rename)", async () => {
		const source = srcPath("bad.yml");
		fs.writeFileSync(source, "key: [unclosed\n");
		const result = await translateFinding(makeFinding(source, "yaml"));
		expect(result).toBeNull();
		expect(fs.existsSync(source)).toBe(true);
		// No .bak sibling created either.
		expect(fs.existsSync(`${source}.migrated-2026-05-21.bak`)).toBe(false);
	});
});

describe("translateFinding: permissions", () => {
	it("backup is created (rename preserves perms)", async () => {
		const source = srcPath("config.yml");
		fs.writeFileSync(source, "defaultThinkingLevel: medium\n", { mode: 0o600 });
		const result = await translateFinding(makeFinding(source, "yaml"));
		expect(result).not.toBeNull();
		const st = await fsp.stat(result!.bakPath);
		// Mode bits unchanged.
		expect(st.mode & 0o777).toBe(0o600);
	});
});
