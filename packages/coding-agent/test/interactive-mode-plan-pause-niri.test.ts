import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("InteractiveMode #exitPlanMode", () => {
	it("notifies niri after plan pause state is fully updated", async () => {
		const sourcePath = path.join(import.meta.dir, "../src/modes/interactive-mode.ts");
		const source = await Bun.file(sourcePath).text();
		const methodStart = source.indexOf(
			"async #exitPlanMode(options?: { silent?: boolean; paused?: boolean }): Promise<void> {",
		);
		expect(methodStart).toBeGreaterThanOrEqual(0);

		const nextMethodStart = source.indexOf("\n\tasync #readPlanFile(", methodStart);
		expect(nextMethodStart).toBeGreaterThan(methodStart);

		const exitPlanModeBody = source.slice(methodStart, nextMethodStart);
		const pausedMutation = exitPlanModeBody.indexOf("this.planModePaused = options?.paused ?? false;");
		const modeChangeAppend = exitPlanModeBody.indexOf(
			'this.sessionManager.appendModeChange(paused ? "plan_paused" : "none");',
		);
		const statusMessage = exitPlanModeBody.indexOf(
			'this.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");',
		);
		const niriNotify = exitPlanModeBody.indexOf("this.#niriListener?.();");

		expect(pausedMutation).toBeGreaterThanOrEqual(0);
		expect(modeChangeAppend).toBeGreaterThan(pausedMutation);
		expect(statusMessage).toBeGreaterThanOrEqual(0);
		expect(niriNotify).toBeGreaterThan(modeChangeAppend);
		expect(niriNotify).toBeGreaterThan(statusMessage);
	});
});
