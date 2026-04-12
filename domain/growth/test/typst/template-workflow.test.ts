import { describe, expect, test } from "bun:test";
import { TypstTemplateWorkflow } from "../../src/typst/template-workflow";

describe("TypstTemplateWorkflow", () => {
	test("opens known templates with stable visual seed source", () => {
		const workflow = new TypstTemplateWorkflow();
		const document = workflow.openTemplate("weekly-digest");
		expect(document.template.path).toBe("domain/growth/templates/weekly-digest.typ");
		expect(document.source).toContain("Weekly Digest");
		expect(document.state.blocks.some((block) => block.kind === "variable")).toBe(true);
	});

	test("round-trips template variable edits through the canonical engine", () => {
		const workflow = new TypstTemplateWorkflow();
		workflow.openTemplate("weekly-digest");
		const result = workflow.updateVariable("report_title", "Board Review");
		expect(result.accepted).toBe(true);
		expect(result.source).toContain('#let report_title = "Board Review"');
	});

	test("replaces assets only when they exist in the workflow catalog", () => {
		const workflow = new TypstTemplateWorkflow();
		workflow.openTemplate("weekly-digest");
		const good = workflow.replaceAsset("assets/executive-cover.svg");
		expect(good.accepted).toBe(true);
		expect(good.source).toContain('assets/executive-cover.svg');
		const bad = workflow.replaceAsset("assets/missing.svg");
		expect(bad.accepted).toBe(false);
		if (bad.accepted) throw new Error("Expected asset rejection");
		expect(bad.diagnostics[0]?.message).toContain("not available");
	});

	test("routes agent rewrites and section insertion through the same canonical pipeline", () => {
		const workflow = new TypstTemplateWorkflow();
		const document = workflow.openTemplate("launch-brief");
		const paragraph = document.state.blocks.find((block) => block.kind === "paragraph");
		if (!paragraph) throw new Error("Expected paragraph block");
		const rewrite = workflow.rewriteBlockFromAgent(paragraph.anchor, "Rewritten by the agent for a launch stakeholder.");
		expect(rewrite.accepted).toBe(true);
		expect(rewrite.source).toContain("Rewritten by the agent for a launch stakeholder.");
		const heading = rewrite.state.blocks.find((block) => block.kind === "heading");
		if (!heading) throw new Error("Expected heading block");
		const insertResults = workflow.insertSectionFromAgent({
			afterAnchor: heading.anchor,
			heading: "Agent Summary",
			body: "Inserted section from the agent pipeline.",
		});
		expect(insertResults.every((result) => result.accepted)).toBe(true);
		expect(workflow.document.source).toContain("Agent Summary");
		expect(workflow.document.source).toContain("Inserted section from the agent pipeline.");
	});

	test("populates multiple variables and reports asset usage for template-backed documents", () => {
		const workflow = new TypstTemplateWorkflow();
		workflow.openTemplate("weekly-digest");
		const results = workflow.populateVariables({ report_title: "Digest", date_range: "Week of Apr 19" });
		expect(results.every((result) => result.accepted)).toBe(true);
		expect(workflow.document.source).toContain('#let report_title = "Digest"');
		expect(workflow.document.source).toContain('#let date_range = "Week of Apr 19"');
		expect(workflow.assetUsage()).toEqual(["assets/hero.svg"]);
	});
});
