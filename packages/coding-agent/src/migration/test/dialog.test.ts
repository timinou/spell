/**
 * Unit tests for the migration dialog. Uses in-memory streams to avoid touching
 * real stdin/stdout. ANSI codes are stripped from assertions for readability.
 */

import { describe, expect, it } from "bun:test";
import { Readable, Writable } from "node:stream";
import type { Finding } from "../detect";
import { renderSummary, runMigrationDialog } from "../dialog";

function findings(): Finding[] {
	return [
		{
			source: "/home/user/.spell/agent/config.yml",
			format: "yaml",
			dest: "/home/user/.config/spell/spell.kdl",
			tier: "user",
			bytes: 1024,
		},
		{
			source: "/work/repo/.spell/settings.json",
			format: "json",
			dest: "/work/repo/spell.kdl",
			tier: "project",
			bytes: 256,
		},
	];
}

function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

class CollectStream extends Writable {
	chunks: string[] = [];
	_write(chunk: Buffer | string, _enc: string, cb: () => void): void {
		this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		cb();
	}
	text(): string {
		return strip(this.chunks.join(""));
	}
}

function ttyReadable(lines: string[]): Readable & { isTTY: boolean } {
	const stream = Readable.from(lines.map(l => `${l}\n`));
	(stream as Readable & { isTTY: boolean }).isTTY = true;
	return stream as Readable & { isTTY: boolean };
}

describe("renderSummary", () => {
	it("includes every source path and the destination set", () => {
		const text = strip(renderSummary(findings()));
		expect(text).toMatch(/Migrate Spell config to KDL\?/);
		expect(text).toMatch(/\/home\/user\/\.spell\/agent\/config\.yml/);
		expect(text).toMatch(/\/work\/repo\/\.spell\/settings\.json/);
		expect(text).toMatch(/\/home\/user\/\.config\/spell\/spell\.kdl/);
		expect(text).toMatch(/\/work\/repo\/spell\.kdl/);
		expect(text).toMatch(/yaml/);
		expect(text).toMatch(/json/);
	});

	it("deduplicates destinations", () => {
		const dup: Finding[] = [
			{ source: "/a", format: "yaml", dest: "/dest.kdl", tier: "user", bytes: 1 },
			{ source: "/b", format: "json", dest: "/dest.kdl", tier: "user", bytes: 1 },
		];
		const text = strip(renderSummary(dup));
		const matches = text.match(/\/dest\.kdl/g) ?? [];
		// One in "Will write to:" section. Source list shows /a and /b only.
		expect(matches).toHaveLength(1);
	});
});

describe("runMigrationDialog: non-interactive", () => {
	it("returns 'no' when findings is empty", async () => {
		expect(await runMigrationDialog({ findings: [] })).toBe("no");
	});

	it("returns 'no' when interactive=false (even with findings)", async () => {
		const out = new CollectStream();
		const answer = await runMigrationDialog({
			findings: findings(),
			interactive: false,
			output: out,
		});
		expect(answer).toBe("no");
	});

	it("returns 'no' when input is not a TTY", async () => {
		const out = new CollectStream();
		const input = Readable.from(["y\n"]); // not flagged isTTY
		const answer = await runMigrationDialog({ findings: findings(), output: out, input });
		expect(answer).toBe("no");
	});
});

describe("runMigrationDialog: interactive answers", () => {
	it("accepts 'y' as yes", async () => {
		const out = new CollectStream();
		const ans = await runMigrationDialog({ findings: findings(), output: out, input: ttyReadable(["y"]) });
		expect(ans).toBe("yes");
	});

	it("accepts 'yes'", async () => {
		const out = new CollectStream();
		const ans = await runMigrationDialog({ findings: findings(), output: out, input: ttyReadable(["yes"]) });
		expect(ans).toBe("yes");
	});

	it("accepts 'n' as no", async () => {
		const out = new CollectStream();
		const ans = await runMigrationDialog({ findings: findings(), output: out, input: ttyReadable(["n"]) });
		expect(ans).toBe("no");
	});

	it("empty answer (just Enter) is no", async () => {
		const out = new CollectStream();
		const ans = await runMigrationDialog({ findings: findings(), output: out, input: ttyReadable([""]) });
		expect(ans).toBe("no");
	});

	it("accepts 's' as skip-forever", async () => {
		const out = new CollectStream();
		const ans = await runMigrationDialog({ findings: findings(), output: out, input: ttyReadable(["s"]) });
		expect(ans).toBe("skip-forever");
	});

	it("accepts 'd' as diff", async () => {
		const out = new CollectStream();
		const ans = await runMigrationDialog({ findings: findings(), output: out, input: ttyReadable(["d"]) });
		expect(ans).toBe("diff");
	});

	it("is case-insensitive", async () => {
		const out = new CollectStream();
		const ans = await runMigrationDialog({ findings: findings(), output: out, input: ttyReadable(["YES"]) });
		expect(ans).toBe("yes");
	});

	it("warns on unknown answers and gives up cleanly on EOF", async () => {
		const out = new CollectStream();
		const ans = await runMigrationDialog({
			findings: findings(),
			output: out,
			input: ttyReadable(["maybe"]),
		});
		// First invalid answer warns; subsequent prompt hits EOF → returns "no".
		expect(ans).toBe("no");
		expect(out.text()).toMatch(/Unknown answer/);
	});
});
