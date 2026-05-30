import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@spell/pi-coding-agent/config/settings";
import { executeBash } from "@spell/pi-coding-agent/exec/bash-executor";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "spell-bash-spill-"));
}

describe("executeBash low-spill policy", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = makeTempDir();
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		_resetSettingsForTest();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("spills on the low line threshold by default", async () => {
		const artifactPath = path.join(tempDir, "low-spill.txt");
		const result = await executeBash("i=1; while [ $i -le 80 ]; do echo line$i; i=$((i+1)); done", {
			cwd: tempDir,
			timeout: 5000,
			artifactPath,
			artifactUri: "artifact://test/main/bash/0.txt",
		});

		expect(result.truncated).toBe(true);
		expect(result.artifactUri).toBe("artifact://test/main/bash/0.txt");
		expect(result.output).toContain("line80");
		expect(result.output).toContain("line32");
		expect(result.output).not.toContain("line31\n");
		expect(await Bun.file(artifactPath).text()).toContain("line1");
	});

	it("keeps the larger failure residue after spill", async () => {
		const artifactPath = path.join(tempDir, "failure-spill.txt");
		const result = await executeBash("i=1; while [ $i -le 140 ]; do echo line$i; i=$((i+1)); done; exit 7", {
			cwd: tempDir,
			timeout: 5000,
			artifactPath,
			artifactUri: "artifact://test/main/bash/1.txt",
		});

		expect(result.exitCode).toBe(7);
		expect(result.cancelled).toBe(false);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("line140");
		expect(result.output).toContain("line22");
		expect(result.output).not.toContain("line21\n");
	});
});
