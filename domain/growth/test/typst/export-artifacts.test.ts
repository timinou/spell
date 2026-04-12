import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TypstTemplateWorkflow } from "../../src/typst/template-workflow";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "typst-export-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("Typst export artifacts", () => {
	test("exports synchronized SVG and PDF after visual edits", async () => {
		const workflow = new TypstTemplateWorkflow();
		workflow.openTemplate("weekly-digest");
		const variableResult = workflow.updateVariable("report_title", "Export Proof");
		expect(variableResult.accepted).toBe(true);
		const assetResult = workflow.replaceAsset("assets/chart-q2.svg");
		expect(assetResult.accepted).toBe(true);
		const paragraph = workflow.document.state.blocks.find((block) => block.kind === "paragraph");
		if (!paragraph) throw new Error("Expected paragraph block");
		const rewriteResult = workflow.rewriteBlockFromAgent(paragraph.anchor, "Export verification paragraph.");
		expect(rewriteResult.accepted).toBe(true);

		const outDir = await makeTempDir();
		const artifacts = await workflow.exportArtifacts(outDir, "weekly-digest-proof");
		expect(artifacts.pdf.success).toBe(true);
		expect(artifacts.svg.success).toBe(true);
		const [pdfStat, svgStat, sourceText] = await Promise.all([
			fs.stat(artifacts.pdf.outputPath ?? ""),
			fs.stat(artifacts.svg.outputPath ?? ""),
			Bun.file(artifacts.sourcePath).text(),
		]);
		expect(pdfStat.size).toBeGreaterThan(0);
		expect(svgStat.size).toBeGreaterThan(0);
		expect(sourceText).toContain('#let report_title = "Export Proof"');
		expect(sourceText).toContain("Export verification paragraph.");
	});
});
