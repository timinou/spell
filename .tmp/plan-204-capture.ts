import * as path from "node:path";
import { QmlTestHarness } from "@oh-my-pi/pi-qml";

const outputDir = process.argv[2];
if (!outputDir) {
	throw new Error("Usage: bun .tmp/plan-204-capture.ts <output-dir>");
}

const nativeHarnessPath = path.resolve("packages/qml/test/fixtures/TypstDocumentItemHarness.qml");
const editorHarnessPath = path.resolve("domain/growth/src/qml/panels/EditorPanelTestHarness.qml");

function sampleBlocks() {
	return [
		{ anchor: "var-title", kind: "variable", text: 'report_title = "Weekly Digest"', meta: { name: "report_title", value: '"Weekly Digest"' }, editable: true },
		{ anchor: "heading-summary", kind: "heading", text: "Executive Summary", level: 1, meta: {}, editable: true },
		{ anchor: "paragraph-overview", kind: "paragraph", text: "This week the team shipped the native Typst surface and contextual editing shell.", meta: {}, editable: true },
		{ anchor: "list-highlights-1", kind: "list_item", text: "Highlight the summary with a single click.", meta: {}, editable: true },
		{ anchor: "image-hero", kind: "image", text: "assets/hero.svg", meta: { path: "assets/hero.svg" }, editable: true },
		{ anchor: "table-metrics", kind: "table", text: "", meta: { rows: [["Metric", "Value"], ["CTR", "4.2%"]] }, editable: true },
	];
}

async function captureNativeSurface(): Promise<void> {
	const harness = new QmlTestHarness({ width: 960, height: 720 });
	await harness.setup(nativeHarnessPath);
	await harness.screenshot(path.join(outputDir, "01-native-surface-foundation.png"));
	await harness.teardown();
}

async function captureEditorShell(): Promise<void> {
	const harness = new QmlTestHarness({ width: 1440, height: 900 });
	await harness.setup(editorHarnessPath);
	await Bun.sleep(80);
	await harness.screenshot(path.join(outputDir, "02-main-editing-surface.png"));

	await harness.sendMessage({ type: "set_source", blocks: sampleBlocks(), selectedAnchor: "paragraph-overview" });
	await Bun.sleep(80);
	await harness.screenshot(path.join(outputDir, "03-contextual-sidebar-paragraph.png"));

	await harness.sendMessage({ type: "set_source", blocks: sampleBlocks(), selectedAnchor: "table-metrics" });
	await Bun.sleep(80);
	await harness.screenshot(path.join(outputDir, "04-contextual-sidebar-table.png"));

	await harness.sendMessage({ type: "open_template_drawer" });
	await Bun.sleep(120);
	await harness.screenshot(path.join(outputDir, "05-template-flow.png"));

	await harness.reset();
	await harness.sendMessage({ type: "set_source", blocks: sampleBlocks(), selectedAnchor: "image-hero" });
	await harness.sendMessage({ type: "open_asset_drawer" });
	await Bun.sleep(120);
	await harness.screenshot(path.join(outputDir, "06-asset-picker-flow.png"));

	await harness.reset();
	await harness.sendMessage({ type: "set_force_degraded", value: true });
	await Bun.sleep(100);
	await harness.screenshot(path.join(outputDir, "07-preview-only-mode.png"));

	await harness.reset();
	await harness.sendMessage({ type: "set_source", source: '= Title\n\n#show heading: set text(fill: red)\n\nBody' });
	await harness.sendMessage({
		type: "set_last_hit",
		hit: { kind: "noneditable-preview", anchor: "unsupported-1", blockKind: "unsupported", reason: "unsupported_syntax" },
	});
	await Bun.sleep(100);
	await harness.screenshot(path.join(outputDir, "08-unsupported-construct-marker.png"));

	await harness.sendMessage({ type: "open_recovery" });
	await Bun.sleep(100);
	await harness.screenshot(path.join(outputDir, "09-recovery-source-mode.png"));

	await harness.teardown();
}

await captureNativeSurface();
await captureEditorShell();
console.log(outputDir);
