import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { QmlTestHarness } from "../src/test-harness";

const harnessPath = path.resolve(import.meta.dir, "fixtures", "TypstDocumentItemHarness.qml");

describe("TypstDocumentItem", () => {
	let harness: QmlTestHarness;

	beforeEach(async () => {
		harness = new QmlTestHarness({ width: 960, height: 720 });
		await harness.setup(harnessPath);
	});

	afterEach(async () => {
		await harness.teardown();
	});

	it("initializes in interactive mode and resolves editable hits", async () => {
		const state = await harness.query<{
			ready: boolean;
			degraded: boolean;
			capability: string;
			svgLength: number;
			blockCount: number;
		}>("state");
		expect(state.ready).toBe(true);
		expect(state.degraded).toBe(false);
		expect(state.capability).toBe("interactive");
		expect(state.svgLength).toBeGreaterThan(200);
		expect(state.blockCount).toBeGreaterThan(3);

		const hit = await harness.query<{ kind: string; blockKind?: string; block_kind?: string; reason?: string }>(
			"hit",
		);
		expect(hit.kind).toBe("editable-span");
		expect(hit.blockKind ?? hit.block_kind).toBe("heading");
	});

	it("switches into preview-only mode without crashing", async () => {
		await harness.sendMessage({ type: "set_force_degraded", value: true });
		const state = await harness.query<{
			degraded: boolean;
			capability: string;
			capabilityReason: string;
		}>("state");
		expect(state.degraded).toBe(true);
		expect(state.capability).toBe("preview_only");
		expect(state.capabilityReason).toBe("forced_fallback");

		const hit = await harness.query<{ kind: string; reason?: string }>("hit");
		expect(hit.kind).toBe("noneditable-preview");
		expect(hit.reason).toBe("forced_fallback");
	});

	it("enters recovery mode for unbalanced input", async () => {
		await harness.sendMessage({
			type: "set_source",
			source: '= Broken\n\n#image("assets/hero.png"\n',
		});
		const state = await harness.query<{
			capability: string;
			capabilityReason: string;
			statusMessage: string;
		}>("state");
		expect(state.capability).toBe("recovery_only");
		expect(state.capabilityReason).toBe("syntax_error");
		expect(state.statusMessage).toContain("recovery mode");
	});
});
