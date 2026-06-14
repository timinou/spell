import { describe, expect, test } from "bun:test";
import { parse } from "@bgotink/kdl";

import { parseDisciplineBlocks } from "@spell/pi-coding-agent/config/kdl-discipline";
import { parseSpellKdl, unifiedDisciplines } from "@spell/pi-coding-agent/config/spell-kdl";

function parseOne(kdl: string) {
	const blocks = parseDisciplineBlocks(parse(kdl));
	return blocks[0];
}

describe("kdl-discipline — trigger forms", () => {
	test("on manual (default)", () => {
		const d = parseOne(`discipline "r" { on manual }`);
		expect(d?.on).toEqual({ kind: "manual" });
	});

	test("on tool=\"x\" property form", () => {
		const d = parseOne(`discipline "mock" { on tool="generate_ui_screen" }`);
		expect(d?.on).toEqual({ kind: "tool", tool: "generate_ui_screen" });
	});

	test("on layer=\"x\" property form", () => {
		const d = parseOne(`discipline "q" { on layer="api" }`);
		expect(d?.on).toEqual({ kind: "layer", layer: "api" });
	});

	test("on auto", () => {
		const d = parseOne(`discipline "a" { on auto }`);
		expect(d?.on).toEqual({ kind: "auto" });
	});

	test("no on node + command → manual", () => {
		const d = parseOne(`discipline "r" { command "/r" }`);
		expect(d?.on).toEqual({ kind: "manual" });
		expect(d?.command).toBe("/r");
	});

	test("on tool \"x\" arg+arg form", () => {
		const d = parseOne(`discipline "m" { on tool "generate_ui_screen" }`);
		expect(d?.on).toEqual({ kind: "tool", tool: "generate_ui_screen" });
	});

	test("malformed `on tool` (no value) falls back to manual + warns (W4.4 diagnostic)", () => {
		const warnings: string[] = [];
		const blocks = parseDisciplineBlocks(parse(`discipline "oops" { on tool }`), m => warnings.push(m));
		expect(blocks[0]?.on).toEqual({ kind: "manual" });
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("oops");
		expect(warnings[0]).toContain("will not fire");
	});

	test("well-formed triggers emit no warning", () => {
		const warnings: string[] = [];
		parseDisciplineBlocks(parse(`discipline "ok" { on tool="x" }`), m => warnings.push(m));
		expect(warnings.length).toBe(0);
	});
});

describe("kdl-discipline — inject", () => {
	test("cadence + sections", () => {
		const d = parseOne(`
			discipline "r" {
				inject cadence="once" {
					context "the goal"
					instructions "do the thing"
				}
			}
		`);
		expect(d?.inject?.cadence).toBe("once");
		expect(d?.inject?.sections.context).toBe("the goal");
		expect(d?.inject?.sections.instructions).toBe("do the thing");
	});

	test("default cadence carry", () => {
		const d = parseOne(`discipline "r" { inject { context "x" } }`);
		expect(d?.inject?.cadence).toBe("carry");
	});

	test("empty inject dropped", () => {
		const d = parseOne(`discipline "r" { inject { } }`);
		expect(d?.inject).toBeUndefined();
	});
});

describe("kdl-discipline — verify (incl. swarm)", () => {
	test("swarm gate with count + criteria", () => {
		const d = parseOne(`
			discipline "orchestrate" {
				verify { swarm 3 criteria="security + leaks" }
			}
		`);
		expect(d?.verify?.swarm).toEqual({ count: 3, criteria: "security + leaks" });
	});

	test("classic gates", () => {
		const d = parseOne(`
			discipline "q" {
				verify {
					cmd "bun test"
					commit #true
					review "no regressions"
				}
			}
		`);
		expect(d?.verify?.cmd).toBe("bun test");
		expect(d?.verify?.commit).toBe(true);
		expect(d?.verify?.review).toBe("no regressions");
	});

	test("swarm count 0 ignored", () => {
		const d = parseOne(`discipline "q" { verify { swarm 0 } }`);
		expect(d?.verify).toBeUndefined();
	});

	test("swarm non-integer count ignored", () => {
		const d = parseOne(`discipline "q" { verify { swarm 2.5 } }`);
		expect(d?.verify).toBeUndefined();
	});
});

describe("kdl-discipline — tools + read-only", () => {
	test("allow + deny", () => {
		const d = parseOne(`discipline "r" { tools { allow "find" "get" ; deny "bash" } }`);
		expect(d?.tools?.allow).toEqual(["find", "get"]);
		expect(d?.tools?.deny).toEqual(["bash"]);
	});

	test("read-only flag", () => {
		const d = parseOne(`discipline "r" { read-only #true }`);
		expect(d?.readOnly).toBe(true);
	});
});

describe("kdl-discipline — full block", () => {
	test("mock-critique tool-discipline parses end-to-end", () => {
		const d = parseOne(`
			discipline "mock-critique" {
				description "Critique generated UI before presenting"
				on tool="generate_ui_screen"
				inject cadence="once" {
					instructions "view first → never present unseen"
				}
			}
		`);
		expect(d?.name).toBe("mock-critique");
		expect(d?.description).toBe("Critique generated UI before presenting");
		expect(d?.on).toEqual({ kind: "tool", tool: "generate_ui_screen" });
		expect(d?.inject?.cadence).toBe("once");
		expect(d?.origin).toBe("discipline");
	});
});

describe("spell-kdl — discipline blocks + unifiedDisciplines", () => {
	test("parses discipline blocks from full config", async () => {
		const cfg = await parseSpellKdl(`
			discipline "mock-critique" {
				on tool="generate_ui_screen"
				inject cadence="once" { instructions "critique" }
			}
			policy "api-quality" layer="api" {
				gate-commit #true
				gate-cmd "bun test"
			}
		`);
		expect(cfg.disciplines?.length).toBe(1);
		expect(cfg.disciplines?.[0]?.name).toBe("mock-critique");

		const unified = unifiedDisciplines(cfg);
		// 1 explicit + 1 desugared policy
		expect(unified.length).toBe(2);
		const byTrigger = unified.map(d => d.on.kind).sort();
		expect(byTrigger).toEqual(["layer", "tool"]);
	});

	test("explicit discipline overrides same-named policy", async () => {
		const cfg = await parseSpellKdl(`
			discipline "api-quality" {
				on layer="api"
				inject { context "explicit wins" }
			}
			policy "api-quality" layer="api" {
				gate-commit #true
			}
		`);
		const unified = unifiedDisciplines(cfg);
		const apiQuality = unified.filter(d => d.name === "api-quality");
		expect(apiQuality.length).toBe(1);
		expect(apiQuality[0]?.origin).toBe("discipline");
	});
});
