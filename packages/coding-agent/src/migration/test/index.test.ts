/**
 * End-to-end migration tests: detect → prompt → translate, integrated.
 * Uses in-memory streams to drive the dialog without touching real stdin.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { maybeRunMigration } from "../index";

let tmpRoot: string;
let userAgentDir: string;
let projectDir: string;
let projectAgentDir: string;
let userDest: string;
let projectDest: string;

beforeEach(() => {
	tmpRoot = path.join(os.tmpdir(), "migration-index", Snowflake.next());
	userAgentDir = path.join(tmpRoot, "home", ".spell", "agent");
	projectDir = path.join(tmpRoot, "project");
	projectAgentDir = path.join(projectDir, ".spell");
	fs.mkdirSync(userAgentDir, { recursive: true });
	fs.mkdirSync(projectAgentDir, { recursive: true });
	userDest = path.join(tmpRoot, "user-config", "spell.kdl");
	projectDest = path.join(projectDir, "spell.kdl");
});

afterEach(() => {
	if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true });
});

function options(extra: Record<string, unknown> = {}) {
	return {
		cwd: projectDir,
		agentDir: userAgentDir,
		userKdlDest: userDest,
		projectKdlDest: projectDest,
		skipMarkerPath: path.join(tmpRoot, "skip-marker"),
		...extra,
	};
}

function ttyReadable(line: string): Readable & { isTTY: boolean } {
	const s = Readable.from([`${line}\n`]);
	(s as Readable & { isTTY: boolean }).isTTY = true;
	return s as Readable & { isTTY: boolean };
}

class NullStream extends Writable {
	_write(_chunk: unknown, _enc: string, cb: () => void): void {
		cb();
	}
}

describe("maybeRunMigration: no findings", () => {
	it("no-op when nothing legacy exists", async () => {
		const r = await maybeRunMigration(options({ interactive: false }));
		expect(r.action).toBe("no-findings");
		expect(r.findings).toEqual([]);
		expect(r.translated).toEqual([]);
	});
});

describe("maybeRunMigration: auto-yes (CI mode)", () => {
	it("translates without prompting when {yes:true}", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "defaultThinkingLevel: high\n");
		const r = await maybeRunMigration(options({ yes: true, interactive: false }));
		expect(r.action).toBe("auto-yes");
		expect(r.translated).toHaveLength(1);
		expect(fs.existsSync(userDest)).toBe(true);
		expect(fs.readFileSync(userDest, "utf8")).toMatch(/model[\s\S]*thinking[\s\S]*high/);
	});

	it("translates BOTH user and project tier findings in one run", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "defaultThinkingLevel: high\n");
		fs.writeFileSync(path.join(projectAgentDir, "settings.json"), '{"theme":{"dark":"anthracite"}}');
		const r = await maybeRunMigration(options({ yes: true }));
		expect(r.action).toBe("auto-yes");
		expect(r.translated).toHaveLength(2);
		expect(fs.existsSync(userDest)).toBe(true);
		expect(fs.existsSync(projectDest)).toBe(true);
	});
});

describe("maybeRunMigration: auto-no", () => {
	it("does NOT translate when {no:true}", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "defaultThinkingLevel: high\n");
		const r = await maybeRunMigration(options({ no: true }));
		expect(r.action).toBe("auto-no");
		expect(r.translated).toHaveLength(0);
		expect(fs.existsSync(userDest)).toBe(false);
		// Source untouched
		expect(fs.existsSync(path.join(userAgentDir, "config.yml"))).toBe(true);
	});
});

describe("maybeRunMigration: interactive yes", () => {
	it("user says 'y' → translates", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "defaultThinkingLevel: medium\n");
		const r = await maybeRunMigration(
			options({
				interactive: true,
				input: ttyReadable("y"),
				output: new NullStream(),
			}),
		);
		expect(r.action).toBe("yes");
		expect(r.translated).toHaveLength(1);
		expect(fs.existsSync(userDest)).toBe(true);
	});
});

describe("maybeRunMigration: interactive no", () => {
	it("user says 'n' → no translation, source preserved", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "defaultThinkingLevel: medium\n");
		const r = await maybeRunMigration(
			options({
				interactive: true,
				input: ttyReadable("n"),
				output: new NullStream(),
			}),
		);
		expect(r.action).toBe("no");
		expect(r.translated).toHaveLength(0);
		expect(fs.existsSync(path.join(userAgentDir, "config.yml"))).toBe(true);
	});
});

describe("maybeRunMigration: skip-forever", () => {
	it("user says 's' → marker created, future runs skipped", async () => {
		const source = path.join(userAgentDir, "config.yml");
		fs.writeFileSync(source, "defaultThinkingLevel: low\n");

		// First run: skip-forever
		const r1 = await maybeRunMigration(
			options({
				interactive: true,
				input: ttyReadable("s"),
				output: new NullStream(),
			}),
		);
		expect(r1.action).toBe("skip-forever");
		expect(fs.existsSync(path.join(tmpRoot, "skip-marker"))).toBe(true);

		// Second run: marker present → no findings reported regardless of input.
		const r2 = await maybeRunMigration(
			options({
				interactive: true,
				input: ttyReadable("y"),
				output: new NullStream(),
			}),
		);
		expect(r2.action).toBe("no-findings");
		expect(fs.existsSync(source)).toBe(true);
	});
});

describe("maybeRunMigration: extensibility / shellPath round-trip (GATE 1 P1.1)", () => {
	it("migrates extensions array from legacy settings.json into spell.kdl", async () => {
		const source = path.join(userAgentDir, "settings.json");
		fs.writeFileSync(
			source,
			JSON.stringify({
				extensions: ["/path/a.ts", "/path/b.ts"],
				shellPath: "/bin/zsh",
				disabledExtensions: ["foo"],
				disabledProviders: ["openai"],
			}),
		);
		const r = await maybeRunMigration(options({ yes: true }));
		expect(r.action).toBe("auto-yes");
		const kdl = fs.readFileSync(userDest, "utf8");
		expect(kdl).toMatch(/extensions[\s\S]*\/path\/a\.ts[\s\S]*\/path\/b\.ts/);
		expect(kdl).toMatch(/shell-path[\s\S]*\/bin\/zsh/);
		expect(kdl).toMatch(/disabled-extensions[\s\S]*foo/);
		expect(kdl).toMatch(/disabled-providers[\s\S]*openai/);
	});
});

describe("maybeRunMigration: idempotency", () => {
	it("re-running after acceptance finds nothing (because .bak siblings exist)", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "defaultThinkingLevel: high\n");

		const r1 = await maybeRunMigration(options({ yes: true }));
		expect(r1.action).toBe("auto-yes");

		const r2 = await maybeRunMigration(options({ yes: true }));
		expect(r2.action).toBe("no-findings");
		expect(r2.translated).toEqual([]);
	});
});

describe("maybeRunMigration: non-interactive default", () => {
	it("interactive=false + no force flag → warn-once, no action", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "defaultThinkingLevel: high\n");
		const r = await maybeRunMigration(options({ interactive: false }));
		expect(r.action).toBe("no");
		expect(r.translated).toEqual([]);
		// Source preserved.
		expect(fs.existsSync(path.join(userAgentDir, "config.yml"))).toBe(true);
	});
});
