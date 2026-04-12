import * as path from "node:path";
import { TypstTemplateWorkflow } from "../domain/growth/src/typst/template-workflow";

const outputDir = process.argv[2];
if (!outputDir) {
	throw new Error("Usage: bun .tmp/plan-204-artifacts.ts <output-dir>");
}

const workflow = new TypstTemplateWorkflow();
const document = workflow.openTemplate("weekly-digest");
workflow.updateVariable("report_title", "Artifact Proof");
workflow.updateVariable("date_range", "Week of Apr 26");
workflow.replaceAsset("assets/chart-q2.svg");
const paragraph = document.state.blocks.find((block) => block.kind === "paragraph");
if (!paragraph) {
	throw new Error("Expected paragraph block");
}
workflow.rewriteBlockFromAgent(paragraph.anchor, "Artifact verification paragraph after agent rewrite.");
const heading = workflow.document.state.blocks.find((block) => block.kind === "heading");
if (!heading) {
	throw new Error("Expected heading block");
}
const mapping = workflow.mappingArtifact(
	heading.bounds.x + heading.bounds.width / 2,
	heading.bounds.y + heading.bounds.height / 2,
 );
await Bun.write(path.join(outputDir, "10-mapping-hit-resolution.json"), JSON.stringify(mapping, null, 2));
const artifacts = await workflow.exportArtifacts(outputDir, "11-weekly-digest-export");
await Bun.write(
	path.join(outputDir, "12-export-summary.json"),
	JSON.stringify({
		sourcePath: artifacts.sourcePath,
		pdf: artifacts.pdf,
		svg: artifacts.svg,
	}, null, 2),
);
console.log(JSON.stringify(artifacts));
