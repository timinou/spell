import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";

const HARNESS_QML = path.resolve(import.meta.dir, "../../src/modes/qml/canvas/components/DataTableTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("DataTable QML integration", () => {
	const harness = new QmlTestHarness({ width: 900, height: 600 });

	beforeAll(async () => {
		await harness.setup(HARNESS_QML);
	});

	afterAll(async () => {
		await harness.teardown();
	});

	beforeEach(async () => {
		await harness.reset();
	});

	const sampleData = {
		columns: [
			{ key: "name", label: "Name", width: 200 },
			{ key: "score", label: "Score", width: 100 },
		],
		rows: [
			{ name: "Alice", score: 95 },
			{ name: "Bob", score: 87 },
			{ name: "Carol", score: 92 },
		],
	};

	// ── Data binding ─────────────────────────────────────────────────────────

	it("row count matches data array", async () => {
		await harness.sendMessage({ type: "set_data", data: sampleData });
		expect(await harness.query<number>("rowCount")).toBe(3);
	});

	it("column count matches data array", async () => {
		await harness.sendMessage({ type: "set_data", data: sampleData });
		expect(await harness.query<number>("columnCount")).toBe(2);
	});

	it("column headers are visible", async () => {
		await harness.sendMessage({ type: "set_data", data: sampleData });
		await Bun.sleep(200);
		const nameHeader = await harness.findItems({ objectName: "columnHeader_name" });
		expect(nameHeader.length).toBeGreaterThan(0);
		const scoreHeader = await harness.findItems({ objectName: "columnHeader_score" });
		expect(scoreHeader.length).toBeGreaterThan(0);
	});

	it("empty data renders headers but zero rows", async () => {
		await harness.sendMessage({
			type: "set_data",
			data: { ...sampleData, rows: [] },
		});
		expect(await harness.query<number>("rowCount")).toBe(0);
		await Bun.sleep(200);
		const header = await harness.findItems({ objectName: "columnHeader_name" });
		expect(header.length).toBeGreaterThan(0);
	});

	// ── Row click ────────────────────────────────────────────────────────────

	it("row click emits signal with correct data", async () => {
		await harness.sendMessage({ type: "set_data", data: sampleData });
		await Bun.sleep(200);
		await harness.sendMessage({ type: "simulate_row_click", index: 0 });
		const click = await harness.query<{ index: number; row: Record<string, unknown> }>("lastRowClick");
		expect(click).not.toBeNull();
		expect(click.index).toBe(0);
	});

	// ── Sort ─────────────────────────────────────────────────────────────────

	it("sort click emits sortChanged signal", async () => {
		await harness.sendMessage({
			type: "set_data",
			data: { ...sampleData, sortable: true },
		});
		await Bun.sleep(200);
		await harness.sendMessage({ type: "simulate_sort_click", key: "score" });
		const sort = await harness.query<{ key: string; ascending: boolean }>("lastSortChange");
		expect(sort).not.toBeNull();
		expect(sort.key).toBe("score");
		expect(sort.ascending).toBe(true);
	});

	// ── Highlight ────────────────────────────────────────────────────────────

	it("highlightRow causes rows to render", async () => {
		await harness.sendMessage({
			type: "set_data",
			data: { ...sampleData, highlightRow: 0 },
		});
		await Bun.sleep(200);
		const rows = await harness.findItems({ objectName: "tableRow" });
		expect(rows.length).toBeGreaterThan(0);
	});

	// ── Extra fields ─────────────────────────────────────────────────────────

	it("data with extra fields beyond columns does not crash", async () => {
		const withExtra = {
			columns: [{ key: "name", label: "Name" }],
			rows: [{ name: "Alice", extra: "ignored", another: 42 }],
		};
		await harness.sendMessage({ type: "set_data", data: withExtra });
		expect(await harness.query<number>("rowCount")).toBe(1);
	});

	// ── Null/undefined handling ──────────────────────────────────────────────

	it("null tableData yields zero counts", async () => {
		expect(await harness.query<number>("rowCount")).toBe(0);
		expect(await harness.query<number>("columnCount")).toBe(0);
	});
});
