// FEAT-816: shrink guard removed (high false-positive rate). The only
// remaining write guard is the structural parse-regression probe.
//
// Historical context: prior implementation of `evaluateWriteGuards` used
// `executeCodeBuffer({command:"status"})` which pi-natives never
// implemented — the guard was a silent no-op. The replacement based on
// `fs.statSync` + size ratios then over-blocked on legitimate refactors.
// We now lean on the parse probe alone; refactors that legitimately
// shrink a file are no longer rejected.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateWriteGuards } from "@oh-my-pi/pi-coding-agent/tools/managed-buffer-guards";

function bigParseableSource() {
	const lines: string[] = [];
	for (let i = 0; i < 2000; i++) lines.push(`export const keep_${i} = ${i};`);
	return `${lines.join("\n")}\n`;
}

const PARSEABLE_STUB = `import * as x from "node:fs";\nimport * as y from "node:path";\n`;

describe("evaluateWriteGuards contract", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "guard-contract-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("allows writes that grow a file", async () => {
		const file = join(dir, "small.ts");
		writeFileSync(file, "export const x = 1;\n");
		expect((await evaluateWriteGuards(file, bigParseableSource())).ok).toBe(true);
	});

	it("allows writes that shrink a file (refactor / dead-code removal)", async () => {
		const file = join(dir, "big.ts");
		writeFileSync(file, bigParseableSource());
		expect((await evaluateWriteGuards(file, PARSEABLE_STUB)).ok).toBe(true);
	});

	it("allows new-file writes (no original on disk)", async () => {
		expect((await evaluateWriteGuards(join(dir, "new.ts"), PARSEABLE_STUB)).ok).toBe(true);
	});

	it("ignores non-code-supported paths (text files are unguarded)", async () => {
		const file = join(dir, "README.txt");
		writeFileSync(file, bigParseableSource());
		expect((await evaluateWriteGuards(file, PARSEABLE_STUB)).ok).toBe(true);
	});

	it("force:true is a no-op on non-existent files", async () => {
		expect((await evaluateWriteGuards(join(dir, "new.ts"), PARSEABLE_STUB, { force: true })).ok).toBe(true);
	});
});
