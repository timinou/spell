import { describe, expect, test } from "bun:test";

import type { ModeConfig } from "@spell/pi-coding-agent/capability/mode";
import {
	type Discipline,
	hasInject,
	hasVerify,
	injectBody,
	modeToDiscipline,
	policyToDiscipline,
	toolDiscipline,
	toolDisciplineMap,
} from "@spell/pi-coding-agent/config/discipline";
import type { TaskPolicy } from "@spell/pi-coding-agent/config/task-policies";

function makeMode(overrides: Partial<ModeConfig["frontmatter"]> = {}, sections = {}): ModeConfig {
	return {
		name: "orchestrate",
		path: "spell.kdl",
		frontmatter: {
			command: "/orchestrate",
			description: "Own architecture",
			contextPolicy: "carry",
			...overrides,
		},
		sections: { custom: {}, ...sections },
		level: "project",
		_source: { id: "spell.kdl", path: "spell.kdl", level: "project" } as ModeConfig["_source"],
	};
}

describe("discipline normalizer — mode (role) desugar", () => {
	test("manual trigger, carry cadence by default", () => {
		const d = modeToDiscipline(makeMode({}, { context: "ctx", instructions: "do x" }));
		expect(d.on).toEqual({ kind: "manual" });
		expect(d.inject?.cadence).toBe("carry");
		expect(d.command).toBe("/orchestrate");
		expect(d.origin).toBe("mode");
		expect(d.inject?.sections.context).toBe("ctx");
	});

	test("context-policy fresh → once cadence", () => {
		const d = modeToDiscipline(makeMode({ contextPolicy: "fresh" }));
		expect(d.inject?.cadence).toBe("once");
	});

	test("carries readOnly and tools constraints", () => {
		const d = modeToDiscipline(makeMode({ readOnly: true, tools: { allow: ["find", "get"] } }));
		expect(d.readOnly).toBe(true);
		expect(d.tools?.allow).toEqual(["find", "get"]);
	});
});

describe("discipline normalizer — policy (layer gate) desugar", () => {
	const policy: TaskPolicy = {
		name: "api-quality",
		description: "API quality gate",
		match: { layer: "api" },
		verify: { commit: true, cmd: "bun test" },
		inject: "Hold the API contract.",
	};

	test("layer trigger from match.layer", () => {
		const d = policyToDiscipline(policy);
		expect(d.on).toEqual({ kind: "layer", layer: "api" });
		expect(d.origin).toBe("policy");
	});

	test("verify gate preserved", () => {
		const d = policyToDiscipline(policy);
		expect(d.verify?.commit).toBe(true);
		expect(d.verify?.cmd).toBe("bun test");
	});

	test("inject text → once cadence context section", () => {
		const d = policyToDiscipline(policy);
		expect(d.inject?.cadence).toBe("once");
		expect(d.inject?.sections.context).toBe("Hold the API contract.");
	});

	test("no inject when policy has none", () => {
		const d = policyToDiscipline({ ...policy, inject: undefined });
		expect(d.inject).toBeUndefined();
	});
});

describe("discipline normalizer — tool-discipline", () => {
	test("tool trigger, once cadence", () => {
		const d = toolDiscipline("mock-critique", "generate_ui_screen", {
			instructions: "view first → critique",
			custom: {},
		});
		expect(d.on).toEqual({ kind: "tool", tool: "generate_ui_screen" });
		expect(d.inject?.cadence).toBe("once");
		expect(d.origin).toBe("tool");
	});
});

describe("discipline — mode and policy converge to identical shape modulo trigger", () => {
	test("both produce a Discipline with on/inject/origin", () => {
		const fromMode = modeToDiscipline(makeMode());
		const fromPolicy = policyToDiscipline({
			name: "p",
			match: { layer: "ui" },
			verify: { commit: true },
		});
		const keys = (d: Discipline) => Object.keys(d).sort();
		// Same structural surface — the only required divergence is the trigger kind.
		expect(fromMode.on.kind).toBe("manual");
		expect(fromPolicy.on.kind).toBe("layer");
		expect(keys(fromMode)).toContain("on");
		expect(keys(fromPolicy)).toContain("on");
	});
});

describe("discipline — verify with swarm", () => {
	test("hasVerify true for swarm-only gate", () => {
		expect(hasVerify({ swarm: { count: 3 } })).toBe(true);
	});
	test("hasVerify false for empty", () => {
		expect(hasVerify({})).toBe(false);
		expect(hasVerify(undefined)).toBe(false);
	});
	test("hasVerify true for classic cmd gate", () => {
		expect(hasVerify({ cmd: "bun test" })).toBe(true);
	});
});

describe("discipline — hasInject", () => {
	test("true when any prose section non-empty", () => {
		expect(hasInject({ cadence: "carry", sections: { context: "x", custom: {} } })).toBe(true);
		expect(hasInject({ cadence: "once", sections: { instructions: "y", custom: {} } })).toBe(true);
	});
	test("false when all empty", () => {
		expect(hasInject({ cadence: "carry", sections: { custom: {} } })).toBe(false);
		expect(hasInject(undefined)).toBe(false);
	});
});

describe("discipline — injectBody", () => {
	test("joins context/instructions/focus in order", () => {
		const body = injectBody({
			cadence: "once",
			sections: { context: "c", instructions: "i", focusAreas: "f", custom: {} },
		});
		expect(body).toBe("c\n\ni\n\nf");
	});
	test("empty for no inject", () => {
		expect(injectBody(undefined)).toBe("");
	});
});

describe("discipline — toolDisciplineMap (session injection selection)", () => {
	test("keys only on-tool disciplines with inject prose", () => {
		const map = toolDisciplineMap([
			toolDiscipline("mock", "generate_ui_screen", { instructions: "critique", custom: {} }),
			modeToDiscipline(makeMode()), // manual → excluded
			{ name: "empty", on: { kind: "tool", tool: "edit" }, origin: "discipline" }, // no inject → excluded
		]);
		expect([...map.keys()]).toEqual(["generate_ui_screen"]);
		expect(map.get("generate_ui_screen")?.name).toBe("mock");
	});
});
