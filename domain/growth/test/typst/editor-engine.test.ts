import { describe, expect, test } from "bun:test";
import { TypstVisualEditEngine } from "../../src/typst/editor-engine";
import type { TypstBlockModel } from "@oh-my-pi/pi-natives";

const baseSource = [
	'#let report_title = "Q1 Review"',
	"= Executive Summary",
	"",
	"This is a paragraph with emphasis targets.",
	"",
	"- Alpha",
	"- Beta",
	"",
	'#image("assets/hero.png")',
	"",
	"| Name | Value |",
	"| CTR | 4.2% |",
	"",
	"Closing paragraph.",
].join("\n");

function blockBy(stateBlocks: TypstBlockModel[], predicate: (block: TypstBlockModel) => boolean): TypstBlockModel {
	const block = stateBlocks.find(predicate);
	if (!block) {
		throw new Error("Expected block was not found");
	}
	return block;
}

describe("TypstVisualEditEngine", () => {
	test("resolves rendered hits back to editable source spans", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(baseSource);
		const heading = blockBy(engine.state.blocks, (block) => block.kind === "heading");
		const hit = engine.hitTest(
			heading.bounds.x + heading.bounds.width / 2,
			heading.bounds.y + heading.bounds.height / 2,
		);
		expect(hit.kind).toBe("editable-span");
		if (hit.kind !== "editable-span") throw new Error("Expected editable hit");
		expect(hit.blockKind).toBe("heading");
		expect(hit.span.startLine).toBe(2);
	});

	test("updates paragraph text from the visual surface", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(baseSource);
		const paragraph = blockBy(engine.state.blocks, (block) => block.kind === "paragraph" && block.text.includes("emphasis"));
		const result = engine.applyEdit({
			op: "set_block_text",
			anchor: paragraph.anchor,
			text: "This paragraph was edited from the visual canvas.",
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(result.accepted).toBe(true);
		expect(result.source).toContain("This paragraph was edited from the visual canvas.");
	});

	test("promotes a paragraph into a heading", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(baseSource);
		const closing = blockBy(engine.state.blocks, (block) => block.kind === "paragraph" && block.text === "Closing paragraph.");
		const result = engine.applyEdit({
			op: "set_block_kind",
			anchor: closing.anchor,
			kind: "heading",
			level: 2,
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(result.accepted).toBe(true);
		expect(result.source).toContain("== Closing paragraph.");
	});

	test("toggles strong styling on a text range", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(baseSource);
		const paragraph = blockBy(engine.state.blocks, (block) => block.kind === "paragraph" && block.text.includes("emphasis"));
		const start = paragraph.text.indexOf("emphasis");
		const end = start + "emphasis".length;
		const result = engine.applyEdit({
			op: "toggle_inline_style",
			anchor: paragraph.anchor,
			style: "strong",
			startOffset: start,
			endOffset: end,
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(result.accepted).toBe(true);
		expect(result.source).toContain("**emphasis**");
	});

	test("inserts moves and deletes list items", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(baseSource);
		const alpha = blockBy(engine.state.blocks, (block) => block.kind === "list_item" && block.text === "Alpha");
		const beta = blockBy(engine.state.blocks, (block) => block.kind === "list_item" && block.text === "Beta");
		const inserted = engine.applyEdit({
			op: "insert_block_after",
			anchor: alpha.anchor,
			kind: "list_item",
			text: "Inserted",
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(inserted.accepted).toBe(true);
		expect(inserted.source).toContain("- Inserted");
		const insertedBlock = blockBy(inserted.state.blocks, (block) => block.kind === "list_item" && block.text === "Inserted");
		const betaAfterInsert = blockBy(inserted.state.blocks, (block) => block.kind === "list_item" && block.text === "Beta");
		const moved = engine.applyEdit({
			op: "move_block",
			anchor: insertedBlock.anchor,
			beforeAnchor: betaAfterInsert.anchor,
			expectedDocumentVersion: inserted.state.documentVersion,
		});
		expect(moved.accepted).toBe(true);
		expect(moved.source.indexOf("- Inserted")).toBeLessThan(moved.source.indexOf("- Beta"));
		const alphaAfterMove = blockBy(moved.state.blocks, (block) => block.kind === "list_item" && block.text === "Alpha");
		const deleted = engine.applyEdit({
			op: "delete_block",
			anchor: alphaAfterMove.anchor,
			expectedDocumentVersion: moved.state.documentVersion,
		});
		expect(deleted.accepted).toBe(true);
		expect(deleted.source).not.toContain("- Alpha");
	});

	test("replaces image asset references canonically", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(baseSource);
		const image = blockBy(engine.state.blocks, (block) => block.kind === "image");
		const result = engine.applyEdit({
			op: "replace_asset_ref",
			anchor: image.anchor,
			path: "assets/updated-hero.png",
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(result.accepted).toBe(true);
		expect(result.source).toContain('#image("assets/updated-hero.png")');
	});

	test("edits supported table cells without losing structure", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(baseSource);
		const table = blockBy(engine.state.blocks, (block) => block.kind === "table");
		const result = engine.applyEdit({
			op: "set_table_cell",
			anchor: table.anchor,
			row: 1,
			column: 1,
			value: "5.1%",
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(result.accepted).toBe(true);
		expect(result.source).toContain("| CTR | 5.1% |");
		expect(result.source).toContain("| Name | Value |");
	});

	test("updates template variables through the same canonical pipeline", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(baseSource);
		const variable = blockBy(engine.state.blocks, (block) => block.kind === "variable");
		const result = engine.applyEdit({
			op: "set_variable",
			anchor: variable.anchor,
			name: "report_title",
			value: '"Q2 Review"',
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(result.accepted).toBe(true);
		expect(result.source).toContain('#let report_title = "Q2 Review"');
	});

	test("refuses edits against unsupported Typst syntax instead of corrupting source", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(["= Title", "", "#show heading: set text(fill: red)", "", "Body"].join("\n"));
		const unsupported = blockBy(engine.state.blocks, (block) => block.kind === "unsupported");
		const result = engine.applyEdit({
			op: "set_block_text",
			anchor: unsupported.anchor,
			text: "Impossible",
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(result.accepted).toBe(false);
		if (result.accepted) throw new Error("Expected rejection");
		expect(result.reason).toBe("unsupported_syntax");
		expect(result.source).toContain("#show heading");
	});

	test("recovers from syntax errors and resumes visual editing", () => {
		const engine = new TypstVisualEditEngine();
		engine.load('= Broken\n\n#image("assets/hero.png"\n');
		expect(engine.state.capability).toBe("recovery_only");
		const recovered = engine.applyEdit({
			op: "apply_agent_patch",
			source: baseSource,
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(recovered.accepted).toBe(true);
		expect(recovered.state.capability).not.toBe("recovery_only");
		const paragraph = blockBy(recovered.state.blocks, (block) => block.kind === "paragraph" && block.text.includes("emphasis"));
		const followUp = engine.applyEdit({
			op: "set_block_text",
			anchor: paragraph.anchor,
			text: "Recovered and editable again.",
			expectedDocumentVersion: recovered.state.documentVersion,
		});
		expect(followUp.accepted).toBe(true);
		expect(followUp.source).toContain("Recovered and editable again.");
	});

	test("routes agent-generated edits back through refreshed mapping", () => {
		const engine = new TypstVisualEditEngine();
		engine.load(baseSource);
		const patched = engine.applyEdit({
			op: "apply_agent_patch",
			source: `${baseSource}\n\n== Agent Summary\n\nGenerated section.`,
			expectedDocumentVersion: engine.state.documentVersion,
		});
		expect(patched.accepted).toBe(true);
		const agentHeading = blockBy(patched.state.blocks, (block) => block.kind === "heading" && block.text === "Agent Summary");
		const result = engine.applyEdit({
			op: "set_block_text",
			anchor: agentHeading.anchor,
			text: "Agent Summary Updated",
			expectedDocumentVersion: patched.state.documentVersion,
		});
		expect(result.accepted).toBe(true);
		expect(result.source).toContain("== Agent Summary Updated");
	});
});
