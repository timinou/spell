import { describe, expect, it } from "bun:test";
import * as path from "node:path";

async function readInteractiveModeSource(): Promise<string> {
	const sourcePath = path.join(import.meta.dir, "../src/modes/interactive-mode.ts");
	return Bun.file(sourcePath).text();
}

describe("InteractiveMode plan mode session persistence", () => {
	it("restores persisted plan flavor alongside ultraplan", async () => {
		const source = await readInteractiveModeSource();
		const methodStart = source.indexOf("async #restoreModeFromSession(): Promise<void> {");
		expect(methodStart).toBeGreaterThanOrEqual(0);

		const nextMethodStart = source.indexOf("\n\tasync #enterPlanMode(", methodStart);
		expect(nextMethodStart).toBeGreaterThan(methodStart);

		const restoreBody = source.slice(methodStart, nextMethodStart);
		expect(restoreBody).toContain('const flavor = sessionContext.modeData?.flavor as "design" | undefined;');
		expect(restoreBody).toContain(
			"const modeConfigName = sessionContext.modeData?.modeConfigName as string | undefined;",
		);
		expect(restoreBody).toContain("await this.#enterPlanMode({ planFilePath, ultraplan, flavor, modeConfigName });");
	});

	it("persists ultraplan and flavor in plan mode change entries", async () => {
		const source = await readInteractiveModeSource();
		const methodStart = source.indexOf("async #enterPlanMode(options?: {");
		expect(methodStart).toBeGreaterThanOrEqual(0);

		const nextMethodStart = source.indexOf("\n\tasync #exitPlanMode(", methodStart);
		expect(nextMethodStart).toBeGreaterThan(methodStart);

		const enterBody = source.slice(methodStart, nextMethodStart);
		expect(enterBody).toContain('this.sessionManager.appendModeChange("plan", {');
		expect(enterBody).toContain("planFilePath,");
		expect(enterBody).toContain("ultraplan: options?.ultraplan,");
		expect(enterBody).toContain("flavor: options?.flavor,");
	});
});
