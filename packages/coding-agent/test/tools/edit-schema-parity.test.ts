import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
	cssRemoveDeadStyleOp,
	cssRenameClassTokenOp,
	cssRenameCustomPropOp,
	cssRenameIdTokenOp,
	editOpSchema,
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
} from "../../src/tools/codepath-types";

let tempDir: string;

async function setupTs() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parity-"));
	await fs.writeFile(path.join(dir, "a.ts"), "export function foo() {\n  return 1;\n}\n");
	return dir;
}

describe("PLAN-304 schema/kernel parity — no silent field drop", () => {
	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parity-"));
	});

	afterEach(async () => {
		if (tempDir) {
			try {
				await fs.rm(tempDir, { recursive: true, force: true });
			} catch {}
		}
	});

	test("symbolReplaceOp schema accepts scope:body (prevents silent field drop)", async () => {
		const dir = await setupTs();
		const op = {
			kind: "symbolReplace",
			target: `${path.join(dir, "a.ts")}::foo`,
			scope: "body",
			content: "  return 42;",
		};

		// The critical invariant: TypeBox schema MUST accept scope field
		expect(Value.Check(symbolReplaceOp, op)).toBe(true);

		// Schema correctly defines scope as optional enum
		expect(symbolReplaceOp.properties.scope).toBeDefined();

		// Cleanup
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("every variant export has well-formed TypeBox schema", () => {
		const variants = [
			["fileCreateOp", fileCreateOp],
			["fileWriteOp", fileWriteOp],
			["fileDeleteOp", fileDeleteOp],
			["fileAppendOp", fileAppendOp],
			["filePrependOp", filePrependOp],
			["filePatchOp", filePatchOp],
			["lineReplaceOp", lineReplaceOp],
			["lineInsertOp", lineInsertOp],
			["lineAppendOp", lineAppendOp],
			["linePrependOp", linePrependOp],
			["symbolReplaceOp", symbolReplaceOp],
			["symbolRenameOp", symbolRenameOp],
			["symbolWrapOp", symbolWrapOp],
			["symbolDeleteOp", symbolDeleteOp],
			["symbolInsertBeforeOp", symbolInsertBeforeOp],
			["symbolInsertAfterOp", symbolInsertAfterOp],
			["symbolFindReplaceOp", symbolFindReplaceOp],
			["symbolRawTextReplaceOp", symbolRawTextReplaceOp],
			["fileFindReplaceOp", fileFindReplaceOp],
			["fileRawTextReplaceOp", fileRawTextReplaceOp],
			["symbolMoveOp", symbolMoveOp],
			["symbolCloneOp", symbolCloneOp],
			["symbolSpliceOp", symbolSpliceOp],
			["symbolTransposeOp", symbolTransposeOp],
			["cssRenameClassTokenOp", cssRenameClassTokenOp],
			["cssRenameIdTokenOp", cssRenameIdTokenOp],
			["cssRenameCustomPropOp", cssRenameCustomPropOp],
			["cssRemoveDeadStyleOp", cssRemoveDeadStyleOp],
			["headingPromoteOp", headingPromoteOp],
			["headingDemoteOp", headingDemoteOp],
			["headingReplaceBlockOp", headingReplaceBlockOp],
		];

		for (const [name, schema] of variants) {
			// The tuple element is inferred as `string | TObject<…>` once the
			// union grows wide enough that TS gives up on the tuple shape. The
			// entries above are statically constructed as `[string, TObject]`,
			// so this cast is safe and keeps the assertion readable.
			const s = schema as { properties: Record<string, unknown> };
			expect(schema, `${name} must be defined`).toBeDefined();
			expect(s.properties, `${name} must have properties`).toBeDefined();
			expect((s.properties as { kind?: unknown }).kind, `${name} must have kind discriminator`).toBeDefined();
		}
	});

	test("editOpSchema union has 31+ variants (file + line + symbol + css + heading)", () => {
		const schema = editOpSchema as unknown as { anyOf?: unknown[]; oneOf?: unknown[] };
		const unionLength = schema.anyOf?.length ?? schema.oneOf?.length ?? 0;
		expect(unionLength).toBeGreaterThanOrEqual(31);
	});
});
