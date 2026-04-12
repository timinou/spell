import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";

const HARNESS = path.resolve(import.meta.dir, "../../src/qml/panels/EditorPanelTestHarness.qml");

function sampleBlocks() {
	return [
		{ anchor: "var-title", kind: "variable", text: 'report_title = "Weekly Digest"', meta: { name: "report_title", value: '"Weekly Digest"' }, editable: true },
		{ anchor: "heading-summary", kind: "heading", text: "Executive Summary", level: 1, meta: {}, editable: true },
		{ anchor: "paragraph-overview", kind: "paragraph", text: "This week the team shipped the native Typst surface and contextual editing shell.", meta: {}, editable: true },
		{ anchor: "list-highlights-1", kind: "list_item", text: "Highlight the summary with a single click.", meta: {}, editable: true },
		{ anchor: "image-hero", kind: "image", text: "assets/hero.png", meta: { path: "assets/hero.png" }, editable: true },
		{ anchor: "table-metrics", kind: "table", text: "", meta: { rows: [["Metric", "Value"], ["CTR", "4.2%"]] }, editable: true }
	];
}

describe.skipIf(!isBridgeAvailable())("Editor Panel", () => {
	const harness = new QmlTestHarness({ width: 1440, height: 900 });

	beforeAll(async () => {
		await harness.setup(HARNESS);
	});

	afterAll(async () => {
		await harness.teardown();
	});

	beforeEach(async () => {
		await harness.reset();
	});

	test("renders the visual-first shell with native surface and contextual sidebar", async () => {
		await harness.assertVisible({ objectName: "typstDocumentSurface" });
		await harness.assertVisible({ objectName: "contextualSidebar" });
		const state = await harness.query<{ capability: string; selectedKind: string; currentTemplateId: string }>("state");
		expect(state.capability).toBe("interactive");
		expect(state.selectedKind).toBe("variable");
		expect(state.currentTemplateId).toBe("weekly-digest");
	});

	test("switches templates and preserves a visual editing flow", async () => {
		await harness.sendMessage({ type: "open_template_drawer" });
		await Bun.sleep(50);
		let state = await harness.query<{ templateDrawerOpen: boolean }>("state");
		expect(state.templateDrawerOpen).toBe(true);
		await harness.click({ textContains: "Launch Brief" });
		state = await harness.query<{ currentTemplateId: string; currentPath: string; documentSource: string }>("state");
		expect(state.currentTemplateId).toBe("launch-brief");
		expect(state.currentPath).toContain("launch-brief.typ");
		expect(state.documentSource).toContain("Launch Brief");
	});

	test("supports asset picker and contextual controls for image blocks", async () => {
		await harness.sendMessage({ type: "set_source", blocks: sampleBlocks(), selectedAnchor: "image-hero" });
		let state = await harness.query<{ selectedKind: string }>("state");
		expect(state.selectedKind).toBe("image");
		await harness.sendMessage({ type: "open_asset_drawer" });
		await Bun.sleep(50);
		state = await harness.query<{ assetDrawerOpen: boolean }>("state");
		expect(state.assetDrawerOpen).toBe(true);
		await harness.click({ textContains: "Executive cover" });
		state = await harness.query<{ documentSource: string }>("state");
		expect(state.documentSource).toContain('assets/executive-cover.png');
	});

	test("surfaces degraded and recovery states honestly", async () => {
		await harness.sendMessage({ type: "set_force_degraded", value: true });
		let state = await harness.query<{ capability: string; previewBannerVisible: boolean }>("state");
		expect(state.capability).toBe("preview_only");
		expect(state.previewBannerVisible).toBe(true);
		await harness.sendMessage({ type: "open_recovery" });
		state = await harness.query<{ sourceModeVisible: boolean }>("state");
		expect(state.sourceModeVisible).toBe(true);
		await harness.reset();
		await harness.sendMessage({ type: "set_source", source: '= Broken\n\n#image("assets/hero.png"\n' });
		state = await harness.query<{ capability: string; recoveryBannerVisible: boolean }>("state");
		expect(state.capability).toBe("recovery_only");
		expect(state.recoveryBannerVisible).toBe(true);
	});

	test("exposes agent rewrite and insert affordances", async () => {
		await harness.sendMessage({ type: "set_source", blocks: sampleBlocks(), selectedAnchor: "paragraph-overview" });
		await harness.click({ textContains: "Agent rewrite" });
		let state = await harness.query<{ documentSource: string }>("state");
		expect(state.documentSource).toContain("Agent rewrite:");
		await harness.click({ textContains: "Agent insert" });
		state = await harness.query<{ documentSource: string }>("state");
		expect(state.documentSource).toContain("Agent Summary");
	});
});