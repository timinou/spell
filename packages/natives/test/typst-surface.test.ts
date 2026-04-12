import { describe, expect, it } from "bun:test";
import { TypstSurfaceSession } from "../src/typst-surface";

describe("TypstSurfaceSession", () => {
	it("maps native state and hit-test payloads into TypeScript wrappers", () => {
		const session = new TypstSurfaceSession();
		const state = session.setDocument("= Wrapper Test\n\nParagraph body.\n");
		expect(state.capability).toBe("interactive");
		expect(state.blocks.some(block => block.kind === "heading")).toBe(true);
		const hit = session.hitTest(140, 120);
		expect(hit.kind).toBe("editable-span");
		if (hit.kind !== "editable-span") throw new Error("Expected editable hit");
		expect(hit.blockKind).toBe("heading");
	});

	it("surfaces preview-only fallback truthfully", () => {
		const session = new TypstSurfaceSession({ forceDegraded: true });
		const state = session.setDocument("= Fallback\n\nPreview only");
		expect(state.capability).toBe("preview_only");
		const hit = session.hitTest(140, 120);
		expect(hit.kind).toBe("noneditable-preview");
		if (hit.kind !== "noneditable-preview") throw new Error("Expected preview-only hit");
		expect(hit.reason).toBe("forced_fallback");
	});
});
