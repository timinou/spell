import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";

const HARNESS_QML = path.resolve(import.meta.dir, "../../src/modes/qml/canvas/components/DiffViewTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("DiffView QML integration", () => {
	const harness = new QmlTestHarness();
	beforeAll(async () => {
		await harness.setup(HARNESS_QML);
	});
	afterAll(async () => {
		await harness.teardown();
	});
	beforeEach(async () => {
		await harness.reset();
	});

	const sampleDiff = {
		filename: "src/foo.ts",
		hunks: [
			{
				header: "@@ -1,3 +1,3 @@",
				lines: [
					{ type: "context", text: " const a = 1" },
					{ type: "remove", text: "-const b = 2" },
					{ type: "add", text: "+const b = 3" },
				],
			},
		],
	};

	/** Send diff data and wait for the harness to acknowledge it was set. */
	async function setDiff(data: Record<string, unknown>) {
		await harness.sendMessage({ type: "set_diff", data });
		await harness.waitForBridgeEvent(e => e.type === "event" && (e as any).payload?.type === "diff_set_done", 5_000);
		// Allow QML layout pass to complete
		await Bun.sleep(100);
	}

	it("filename renders in header", async () => {
		await setDiff(sampleDiff);
		await harness.assertVisible({ objectName: "diffFilenameHeader" });
	});

	it("added lines have correct objectName", async () => {
		await setDiff(sampleDiff);
		const addedLines = await harness.findItems({ objectName: "addedLine" });
		expect(addedLines.length).toBeGreaterThan(0);
	});

	it("removed lines have correct objectName", async () => {
		await setDiff(sampleDiff);
		const removedLines = await harness.findItems({ objectName: "removedLine" });
		expect(removedLines.length).toBeGreaterThan(0);
	});

	it("empty diff shows no-changes indicator", async () => {
		await setDiff({ hunks: [] });
		await harness.assertVisible({ objectName: "noChangesIndicator" });
	});

	it("line click emits event", async () => {
		await setDiff(sampleDiff);
		await harness.sendMessage({ type: "emit_click", lineIndex: 0, lineType: "add", text: "+const b = 3" });
		// Brief delay for signal propagation
		await Bun.sleep(50);
		const click = await harness.query<{ lineIndex: number; type: string }>("lastLineClick");
		expect(click).not.toBeNull();
		expect(click!.type).toBe("add");
	});

	it("diff with only additions renders all lines as added", async () => {
		await setDiff({
			hunks: [
				{
					header: "@@ -0,0 +1,2 @@",
					lines: [
						{ type: "add", text: "+line 1" },
						{ type: "add", text: "+line 2" },
					],
				},
			],
		});
		const added = await harness.findItems({ objectName: "addedLine" });
		expect(added.length).toBe(2);
	});
});
