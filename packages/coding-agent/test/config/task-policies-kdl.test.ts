import { describe, expect, it } from "bun:test";
import { parseTaskPoliciesKdl } from "../../src/config/task-policies-kdl";

const FULL_KDL = `
layer "frontend" description="UI work"
layer "api" description="API layer"

policy "fe-gates" layer="frontend" {
	verify-commit #true
	verify-cmd "bun test test/ui/**"
	verify-review "Check accessibility"
	verify-artifact "dist/bundle.js"
	inject "Follow design system conventions"
	description "Frontend quality gates"
}
`;

describe("parseTaskPoliciesKdl", () => {
	it("parses layers", () => {
		const config = parseTaskPoliciesKdl(`
layer "frontend" description="UI work"
layer "api" description="API layer"
`);

		expect(config).toEqual({
			version: 1,
			layers: {
				frontend: { description: "UI work" },
				api: { description: "API layer" },
			},
			policies: [],
		});
	});

	it("parses full policy", () => {
		const config = parseTaskPoliciesKdl(FULL_KDL);

		expect(config).toBeDefined();
		expect(config!.policies).toHaveLength(1);
		expect(config!.policies[0]).toEqual({
			name: "fe-gates",
			description: "Frontend quality gates",
			match: { layer: "frontend" },
			verify: {
				commit: true,
				cmd: "bun test test/ui/**",
				review: "Check accessibility",
				artifact: "dist/bundle.js",
			},
			inject: "Follow design system conventions",
		});
	});

	it("parses multiple policies", () => {
		const config = parseTaskPoliciesKdl(`
layer "frontend" description="UI work"
layer "api" description="API layer"

policy "fe-gates" layer="frontend" {
	gate-cmd "bun test test/ui/**"
}

policy "api-gates" layer="api" {
	verify-cmd "bun check:ts"
}
`);

		expect(config).toBeDefined();
		expect(config!.policies).toEqual([
			{
				name: "fe-gates",
				match: { layer: "frontend" },
				verify: { cmd: "bun test test/ui/**" },
			},
			{
				name: "api-gates",
				match: { layer: "api" },
				verify: { cmd: "bun check:ts" },
			},
		]);
	});

	it("sets inject text from inject child node", () => {
		const config = parseTaskPoliciesKdl(`
policy "fe-gates" layer="frontend" {
	inject "Follow component conventions"
}
`);

		expect(config).toBeDefined();
		expect(config!.policies[0].inject).toBe("Follow component conventions");
	});

	it("sets policy description from description child node", () => {
		const config = parseTaskPoliciesKdl(`
policy "fe-gates" layer="frontend" {
	description "Frontend quality gates"
}
`);

		expect(config).toBeDefined();
		expect(config!.policies[0].description).toBe("Frontend quality gates");
	});

	it("skips policy without name", () => {
		const config = parseTaskPoliciesKdl(`
policy layer="frontend" {
	gate-cmd "bun test"
}

policy "valid-policy" layer="frontend" {
	gate-cmd "bun check:ts"
}
`);

		expect(config).toBeDefined();
		expect(config!.policies).toEqual([
			{
				name: "valid-policy",
				match: { layer: "frontend" },
				verify: { cmd: "bun check:ts" },
			},
		]);
	});

	it("skips policy without layer", () => {
		const config = parseTaskPoliciesKdl(`
policy "missing-layer" {
	gate-cmd "bun test"
}

policy "valid-policy" layer="frontend" {
	gate-cmd "bun check:ts"
}
`);

		expect(config).toBeDefined();
		expect(config!.policies).toEqual([
			{
				name: "valid-policy",
				match: { layer: "frontend" },
				verify: { cmd: "bun check:ts" },
			},
		]);
	});

	it("returns empty config for empty document", () => {
		const config = parseTaskPoliciesKdl("");

		expect(config).toEqual({
			version: 1,
			layers: {},
			policies: [],
		});
	});

	it("returns undefined for invalid KDL", () => {
		const config = parseTaskPoliciesKdl('policy "broken" { gate-cmd "oops"');

		expect(config).toBeUndefined();
	});

	it("ignores unknown child nodes", () => {
		const config = parseTaskPoliciesKdl(`
policy "fe-gates" layer="frontend" {
	gate-cmd "bun test test/ui/**"
	unknown-child "ignored"
	another-unknown #true
}
`);

		expect(config).toBeDefined();
		expect(config!.policies).toEqual([
			{
				name: "fe-gates",
				match: { layer: "frontend" },
				verify: { cmd: "bun test test/ui/**" },
			},
		]);
	});

	it("parses a swarm gate on a policy (FEAT-816)", () => {
		const config = parseTaskPoliciesKdl(`
policy "impl-swarm" layer="implementation" {
	gate-commit #true
	swarm 3 criteria="security · leaks"
}
`);
		expect(config!.policies[0]?.verify).toEqual({ commit: true, swarm: { count: 3, criteria: "security · leaks" } });
	});
});
