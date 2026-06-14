import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { parseSpellKdl, unifiedDisciplines } from "@spell/pi-coding-agent/config/spell-kdl";

describe("project spell.kdl — mock-critique discipline lands", () => {
	test("parses the real spell.kdl discipline block", async () => {
		const root = path.resolve(import.meta.dir, "../../../..");
		const content = await Bun.file(path.join(root, "spell.kdl")).text();
		const cfg = await parseSpellKdl(content, root);
		const mock = cfg.disciplines?.find(d => d.name === "mock-critique");
		expect(mock).toBeDefined();
		expect(mock?.on).toEqual({ kind: "tool", tool: "generate_ui_screen" });
		expect(mock?.inject?.cadence).toBe("once");
		expect(mock?.inject?.sections.instructions).toContain("view first");

		// unified set includes the tool-discipline + the desugared layer policies
		const unified = unifiedDisciplines(cfg);
		expect(unified.some(d => d.name === "mock-critique" && d.on.kind === "tool")).toBe(true);
		expect(unified.some(d => d.on.kind === "layer")).toBe(true);
	});
});
