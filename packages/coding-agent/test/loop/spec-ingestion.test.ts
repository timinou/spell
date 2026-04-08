import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importParsedSpecs } from "../../src/loop/ingestion/importer";
import { parseSpecDirectory } from "../../src/loop/ingestion/parser";
import { evaluateLoopReadiness } from "../../src/loop/ingestion/readiness";
import { validateParsedSpecs } from "../../src/loop/ingestion/validator";

describe("spec ingestion", () => {
	let cwd: string;
	let specDir: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-spec-"));
		specDir = path.join(cwd, "specs");
		await fs.mkdir(specDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("imports valid org specs and preserves id links", async () => {
		const file = path.join(specDir, "spec.org");
		await Bun.write(
			file,
			"#+TITLE: Spec\n#+CUSTOM_ID: SPEC-001-demo\n\nSee [[id:SPEC-001-demo]]\n\n* Acceptance Criteria\n- done\n",
		);
		const parsed = await parseSpecDirectory(specDir);
		expect(validateParsedSpecs(parsed)).toEqual([]);
		const written = await importParsedSpecs(cwd, parsed, specDir);
		expect(await Bun.file(written[0] ?? "").text()).toContain("[[id:SPEC-001-demo]]");
	});

	it("flags missing ids, broken links, and blocks readiness when review model is missing", async () => {
		await Bun.write(path.join(specDir, "broken.org"), "#+TITLE: Broken\n\nSee [[id:MISSING]]\n");
		const parsed = await parseSpecDirectory(specDir);
		const issues = validateParsedSpecs(parsed);
		expect(issues.map(issue => issue.message)).toEqual(
			expect.arrayContaining(["Missing CUSTOM_ID", "Broken [[id:]] link: MISSING"]),
		);
		const readiness = await evaluateLoopReadiness(cwd, parsed, { getModelRole: () => undefined }, ["code"], 0);
		expect(readiness.ok).toBe(false);
		expect(readiness.required.find(check => check.name === "review-model")?.ok).toBe(false);
	});

	it("recognises description-style id links as valid cross-references", async () => {
		const file = path.join(specDir, "spec.org");
		const content = [
			"#+TITLE: Spec",
			"#+CUSTOM_ID: SPEC-001-demo",
			"",
			"See [[id:SPEC-001-demo][the demo]]",
			"",
		].join("\n");
		await Bun.write(file, content);
		const parsed = await parseSpecDirectory(specDir);
		expect(parsed[0]?.links).toEqual(["SPEC-001-demo"]);
		expect(validateParsedSpecs(parsed)).toEqual([]);
	});
});
