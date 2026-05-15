#!/usr/bin/env bun
/**
 * Generate edit.md Op variant table from TypeBox discriminated union schema
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	cssRemoveDeadStyleOp,
	cssRenameClassTokenOp,
	cssRenameCustomPropOp,
	cssRenameIdTokenOp,
	fileAppendOp,
	fileCreateOp,
	fileDeleteOp,
	fileFindReplaceOp,
	filePatchOp,
	filePrependOp,
	fileRawTextReplaceOp,
	fileWriteOp,
	headingDemoteOp,
	headingPromoteOp,
	headingReplaceBlockOp,
	lineAppendOp,
	lineInsertOp,
	linePrependOp,
	lineReplaceOp,
	symbolCloneOp,
	symbolDeleteOp,
	symbolFindReplaceOp,
	symbolInsertAfterOp,
	symbolInsertBeforeOp,
	symbolMoveOp,
	symbolRawTextReplaceOp,
	symbolRenameOp,
	symbolReplaceOp,
	symbolSpliceOp,
	symbolTransposeOp,
	symbolWrapOp,
} from "../src/tools/codepath-types.js";

const variants = [
	{ name: "fileCreate", schema: fileCreateOp },
	{ name: "fileWrite", schema: fileWriteOp },
	{ name: "fileDelete", schema: fileDeleteOp },
	{ name: "fileAppend", schema: fileAppendOp },
	{ name: "filePrepend", schema: filePrependOp },
	{ name: "filePatch", schema: filePatchOp },
	{ name: "lineReplace", schema: lineReplaceOp },
	{ name: "lineInsert", schema: lineInsertOp },
	{ name: "lineAppend", schema: lineAppendOp },
	{ name: "linePrepend", schema: linePrependOp },
	{ name: "symbolReplace", schema: symbolReplaceOp },
	{ name: "symbolRename", schema: symbolRenameOp },
	{ name: "symbolWrap", schema: symbolWrapOp },
	{ name: "symbolDelete", schema: symbolDeleteOp },
	{ name: "symbolInsertBefore", schema: symbolInsertBeforeOp },
	{ name: "symbolInsertAfter", schema: symbolInsertAfterOp },
	{ name: "symbolFindReplace", schema: symbolFindReplaceOp },
	{ name: "symbolRawTextReplace", schema: symbolRawTextReplaceOp },
	{ name: "fileFindReplace", schema: fileFindReplaceOp },
	{ name: "fileRawTextReplace", schema: fileRawTextReplaceOp },
	{ name: "symbolMove", schema: symbolMoveOp },
	{ name: "symbolClone", schema: symbolCloneOp },
	{ name: "symbolSplice", schema: symbolSpliceOp },
	{ name: "symbolTranspose", schema: symbolTransposeOp },
	{ name: "cssRenameClassToken", schema: cssRenameClassTokenOp },
	{ name: "cssRenameIdToken", schema: cssRenameIdTokenOp },
	{ name: "cssRenameCustomProp", schema: cssRenameCustomPropOp },
	{ name: "cssRemoveDeadStyle", schema: cssRemoveDeadStyleOp },
	{ name: "headingPromote", schema: headingPromoteOp },
	{ name: "headingDemote", schema: headingDemoteOp },
	{ name: "headingReplaceBlock", schema: headingReplaceBlockOp },
];

function extractFields(schema: any): { required: string[]; optional: string[] } {
	const props = schema.properties || {};
	const required: string[] = [];
	const optional: string[] = [];

	for (const [key, value] of Object.entries(props)) {
		if (key === "kind" || key === "target") continue; // Skip discriminator and target
		if ((value as any).type === "Optional") {
			optional.push(key);
		} else {
			required.push(key);
		}
	}

	return { required, optional };
}

function generateTable(): string {
	let table = "| kind | target shape | required fields | optional fields |\n";
	table += "|---|---|---|---|\n";

	for (const variant of variants) {
		const { required, optional } = extractFields(variant.schema);
		const targetShape = variant.name.startsWith("file")
			? "bare path"
			: variant.name.startsWith("line")
				? "bare path"
				: variant.name.startsWith("symbol")
					? "path::Symbol"
					: "any";

		table += `| ${variant.name} | ${targetShape} | ${required.join(", ") || "-"} | ${optional.join(", ") || "-"} |\n`;
	}

	return table;
}

function generateLegacyTable(): string {
	const legacyMap = {
		write: "fileWrite or symbolReplace (based on target)",
		delete: "fileDelete or symbolDelete (based on target)",
		rename: "symbolRename",
		wrap: "symbolWrap",
		findAndReplace: "fileFindReplace or symbolFindReplace (based on target)",
		rawTextReplace: "fileRawTextReplace or symbolRawTextReplace (based on target)",
		splice: "symbolSplice",
		move: "symbolMove",
		clone: "symbolClone",
		transpose: "symbolTranspose",
		insertBefore: "symbolInsertBefore",
		insertAfter: "symbolInsertAfter",
		append: "fileAppend",
		prepend: "filePrepend",
		replace: "lineReplace",
		patch: "filePatch",
		promote: "headingPromote",
		demote: "headingDemote",
		replaceCodeBlock: "headingReplaceBlock",
		renameClassToken: "cssRenameClassToken",
		renameIdToken: "cssRenameIdToken",
		renameCustomProperty: "cssRenameCustomProp",
		removeDeadStyle: "cssRemoveDeadStyle",
	};

	let table = "| legacy kind | new kind |\n";
	table += "|---|---|\n";

	for (const [legacy, newKind] of Object.entries(legacyMap)) {
		table += `| ${legacy} | ${newKind} |\n`;
	}

	return table;
}

async function main() {
	const editMdPath = path.join(import.meta.dir, "../src/prompts/tools/edit.md");
	const content = await fs.readFile(editMdPath, "utf-8");

	const opTable = generateTable();
	const legacyTable = generateLegacyTable();

	const generated = `<!-- BEGIN generated:edit-op-table -->

## Op variants

${opTable}

## Legacy aliases (DEPRECATED)

These kind strings are accepted but emit a deprecation note:

${legacyTable}

<!-- END generated:edit-op-table -->`;

	// Replace or insert generated section
	const beginMarker = "<!-- BEGIN generated:edit-op-table -->";
	const endMarker = "<!-- END generated:edit-op-table -->";

	let updatedContent: string;
	if (content.includes(beginMarker)) {
		const before = content.substring(0, content.indexOf(beginMarker));
		const after = content.substring(content.indexOf(endMarker) + endMarker.length);
		updatedContent = before + generated + after;
	} else {
		// Insert before </critical>
		updatedContent = content.replace("</critical>", `${generated}\n\n</critical>`);
	}

	await fs.writeFile(editMdPath, updatedContent, "utf-8");
	console.log("✓ Generated edit.md Op variant table");
}

main().catch(err => {
	console.error("Failed to generate edit prompt:", err);
	process.exit(1);
});
