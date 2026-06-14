import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { loadMergedDisciplines, parseSpellKdl, unifiedDisciplines } from "@spell/pi-coding-agent/config/spell-kdl";

describe("project spell.kdl — swarm layer policy desugars", () => {
	test("parses the real spell.kdl + the implementation-swarm policy", async () => {
		const root = path.resolve(import.meta.dir, "../../../..");
		const content = await Bun.file(path.join(root, "spell.kdl")).text();
		const cfg = await parseSpellKdl(content, root);

		// the reviewer-swarm sub-loop ships as a layer policy (consumer #2)
		const unified = unifiedDisciplines(cfg);
		const implSwarm = unified.find(d => d.name === "implementation-swarm");
		expect(implSwarm?.on).toEqual({ kind: "layer", layer: "implementation" });
		expect(implSwarm?.verify?.swarm?.count).toBe(3);
	});
});

describe("bundled disciplines — mock-critique is universal", () => {
	test("loadMergedDisciplines includes the bundled mock-critique even with an empty project", async () => {
		// Point at a tmp dir with no spell.kdl: only the bundled defaults should surface.
		const tmp = await Bun.file(path.join(import.meta.dir, "nonexistent")).exists();
		expect(tmp).toBe(false);
		const disciplines = await loadMergedDisciplines("/nonexistent-project-dir", "/nonexistent-agent-dir");
		const mock = disciplines.find(d => d.name === "mock-critique");
		expect(mock).toBeDefined();
		expect(mock?.on).toEqual({ kind: "tool", tool: "generate_ui_screen" });
		expect(mock?.inject?.cadence).toBe("once");
		expect(mock?.inject?.sections.instructions).toContain("view first");
	});
});
