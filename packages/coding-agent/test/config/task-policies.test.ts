import { describe, expect, it } from "bun:test";
import {
	applyPolicyGates,
	loadTaskPolicies,
	matchPolicies,
	mergePolicies,
	resolveGates,
	resolveInjectText,
	resolveLayerFromProperties,
	type TaskPolicy,
	type TaskPolicyConfig,
	type TaskVerify,
} from "../../src/config/task-policies";

// Fixtures
// =============================================================================

function makePolicies(): TaskPolicy[] {
	return [
		{
			name: "frontend-journey-tests",
			match: { layer: "frontend" },
			verify: { review: "Journey tests required", cmd: "mix test test/journey/" },
			inject: "Write journey tests.",
		},
		{
			name: "api-contract-tests",
			match: { layer: "api" },
			verify: { cmd: "mix test test/contract/" },
		},
		{
			name: "frontend-docs",
			match: { layer: "frontend" },
			verify: { commit: true },
			inject: "Document the UI story.",
		},
	];
}

describe("matchPolicies", () => {
	const policies = makePolicies();

	it("returns policies matching frontend layer", () => {
		const matched = matchPolicies("frontend", policies);
		expect(matched).toHaveLength(2);
		expect(matched.map(p => p.name)).toEqual(["frontend-journey-tests", "frontend-docs"]);
	});

	it("returns policies matching api layer", () => {
		const matched = matchPolicies("api", policies);
		expect(matched).toHaveLength(1);
		expect(matched[0].name).toBe("api-contract-tests");
	});

	it("returns empty array for unknown layer", () => {
		expect(matchPolicies("unknown", policies)).toEqual([]);
	});

	it("returns empty array for undefined layer", () => {
		expect(matchPolicies(undefined, policies)).toEqual([]);
	});
});

describe("mergePolicies", () => {
	const projectConfig: TaskPolicyConfig = {
		version: 1,
		layers: { frontend: { description: "UI" }, api: { description: "API" } },
		policies: [
			{ name: "frontend-tests", match: { layer: "frontend" }, verify: { cmd: "project-cmd" } },
			{ name: "api-tests", match: { layer: "api" }, verify: { cmd: "api-cmd" } },
		],
	};

	it("mode policy with same name overrides project policy", () => {
		const modePolicies: TaskPolicy[] = [
			{ name: "frontend-tests", match: { layer: "frontend" }, verify: { cmd: "mode-cmd" } },
		];
		const merged = mergePolicies(projectConfig, modePolicies);
		expect(merged.policies).toHaveLength(2);
		const frontendPolicy = merged.policies.find(p => p.name === "frontend-tests");
		expect(frontendPolicy!.verify.cmd).toBe("mode-cmd");
	});

	it("mode policy with different name accumulates", () => {
		const modePolicies: TaskPolicy[] = [
			{ name: "frontend-docs", match: { layer: "frontend" }, verify: { review: "docs required" } },
		];
		const merged = mergePolicies(projectConfig, modePolicies);
		expect(merged.policies).toHaveLength(3);
	});

	it("mode layers merge with project layers, mode wins on conflict", () => {
		const merged = mergePolicies(projectConfig, undefined, {
			frontend: { description: "Mode UI description" },
			infra: { description: "Infrastructure" },
		});
		expect(merged.layers.frontend.description).toBe("Mode UI description");
		expect(merged.layers.api.description).toBe("API");
		expect(merged.layers.infra.description).toBe("Infrastructure");
	});

	it("empty mode policies pass through project policies", () => {
		const merged = mergePolicies(projectConfig, []);
		expect(merged.policies).toEqual(projectConfig.policies);
	});

	it("empty project policies pass through mode policies", () => {
		const modePolicies: TaskPolicy[] = [{ name: "test", match: { layer: "frontend" }, verify: { cmd: "cmd" } }];
		const merged = mergePolicies(undefined, modePolicies);
		expect(merged.policies).toHaveLength(1);
		expect(merged.policies[0].name).toBe("test");
	});
});

describe("resolveGates", () => {
	const policies = makePolicies();

	it("returns merged verify for frontend layer", () => {
		const verify = resolveGates("frontend", policies);
		expect(verify.review).toBe("Journey tests required");
		expect(verify.cmd).toBe("mix test test/journey/");
		expect(verify.commit).toBe(true);
	});

	it("accumulates verify fields from multiple matching policies", () => {
		// frontend-journey-tests provides review + cmd; frontend-docs provides commit
		const verify = resolveGates("frontend", policies);
		expect(verify.review).toBeDefined();
		expect(verify.cmd).toBeDefined();
		expect(verify.commit).toBeDefined();
	});

	it("last match wins when multiple policies set same gate", () => {
		const dupes: TaskPolicy[] = [
			{ name: "a", match: { layer: "frontend" }, verify: { cmd: "first" } },
			{ name: "b", match: { layer: "frontend" }, verify: { cmd: "second" } },
		];
		const verify = resolveGates("frontend", dupes);
		expect(verify.cmd).toBe("second");
	});

	it("returns empty gates for unmatched layer", () => {
		const verify = resolveGates("unknown", policies);
		expect(verify).toEqual({});
	});
});

describe("applyPolicyGates", () => {
	const policies = makePolicies();

	it("fills in missing gate fields from policy", () => {
		const existing: TaskVerify = {};
		const result = applyPolicyGates(existing, "frontend", policies);
		expect(result.review).toBe("Journey tests required");
		expect(result.cmd).toBe("mix test test/journey/");
	});

	it("preserves existing explicit gates over policy defaults", () => {
		const existing: TaskVerify = { cmd: "explicit-cmd" };
		const result = applyPolicyGates(existing, "frontend", policies);
		expect(result.cmd).toBe("explicit-cmd");
		expect(result.review).toBe("Journey tests required");
	});

	it("returns existing gates when no matching policies", () => {
		const existing: TaskVerify = { cmd: "mine" };
		const result = applyPolicyGates(existing, "unknown", policies);
		expect(result.cmd).toBe("mine");
	});

	it("threads the swarm gate from policy into the resolved verify (FEAT-816)", () => {
		const swarmPolicies: TaskPolicy[] = [
			{ name: "impl-swarm", match: { layer: "implementation" }, verify: { swarm: { count: 3, criteria: "sec" } } },
		];
		const resolved = resolveGates("implementation", swarmPolicies);
		expect(resolved.swarm).toEqual({ count: 3, criteria: "sec" });
		const applied = applyPolicyGates({}, "implementation", swarmPolicies);
		expect(applied.swarm).toEqual({ count: 3, criteria: "sec" });
	});

	it("preserves an explicit swarm gate over the policy default", () => {
		const swarmPolicies: TaskPolicy[] = [
			{ name: "impl-swarm", match: { layer: "implementation" }, verify: { swarm: { count: 3 } } },
		];
		const applied = applyPolicyGates({ swarm: { count: 5 } }, "implementation", swarmPolicies);
		expect(applied.swarm).toEqual({ count: 5 });
	});
});

describe("resolveInjectText", () => {
	const policies = makePolicies();

	it("concatenates inject text from matching policies", () => {
		const text = resolveInjectText("frontend", policies);
		expect(text).toContain("Write journey tests.");
		expect(text).toContain("Document the UI story.");
	});

	it("returns undefined for layer with no inject text", () => {
		const text = resolveInjectText("api", policies);
		expect(text).toBeUndefined();
	});

	it("returns undefined for undefined layer", () => {
		expect(resolveInjectText(undefined, policies)).toBeUndefined();
	});
});

describe("resolveLayerFromProperties", () => {
	const propsDb: Record<string, Record<string, string>> = {
		"FEAT-001": { LAYER: "frontend" },
		"FEAT-001::implement-ui": { LAYER: "frontend" },
		"FEAT-002": { LAYER: "frontend" },
		"FEAT-002::api-endpoint": { LAYER: "api" },
		"FEAT-003::no-layer": {},
		"FEAT-003": { LAYER: "infra" },
		"FEAT-004": {},
	};
	const lookupFn = (id: string) => propsDb[id];

	it("returns sub-outline item's own LAYER", () => {
		expect(resolveLayerFromProperties("FEAT-001::implement-ui", lookupFn)).toBe("frontend");
	});

	it("sub-outline LAYER overrides parent LAYER", () => {
		// FEAT-002 is frontend, but FEAT-002::api-endpoint is api
		expect(resolveLayerFromProperties("FEAT-002::api-endpoint", lookupFn)).toBe("api");
	});

	it("falls back to parent LAYER when sub-outline has none", () => {
		expect(resolveLayerFromProperties("FEAT-003::no-layer", lookupFn)).toBe("infra");
	});

	it("returns top-level item LAYER directly", () => {
		expect(resolveLayerFromProperties("FEAT-001", lookupFn)).toBe("frontend");
	});

	it("returns undefined for item without LAYER", () => {
		expect(resolveLayerFromProperties("FEAT-004", lookupFn)).toBeUndefined();
	});

	it("returns undefined for undefined orgItemId", () => {
		expect(resolveLayerFromProperties(undefined, lookupFn)).toBeUndefined();
	});

	it("returns undefined when sub-outline parent doesn't exist", () => {
		expect(resolveLayerFromProperties("NONEXISTENT::sub", lookupFn)).toBeUndefined();
	});
});

describe("loadTaskPolicies", () => {
	it("returns undefined for non-existent directory", async () => {
		const result = await loadTaskPolicies("/tmp/definitely-does-not-exist-spell-test");
		expect(result).toBeUndefined();
	});
});
