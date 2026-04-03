import { describe, expect, it } from "bun:test";
import {
	applyPolicyGates,
	loadTaskPolicies,
	matchPolicies,
	mergePolicies,
	parseTaskPolicies,
	resolveGates,
	resolveInjectText,
	resolveLayerFromProperties,
	type TaskPolicy,
	type TaskPolicyConfig,
	type TaskPolicyGates,
} from "../../src/config/task-policies";

// Fixtures
// =============================================================================

const VALID_YAML = `
version: 1
layers:
  frontend:
    description: "LiveView pages, components, browser interactions"
  api:
    description: "REST/GraphQL endpoints, request/response contracts"
  infra:
    description: "Infrastructure, CI/CD, deployment"
policies:
  - name: frontend-journey-tests
    match:
      layer: frontend
    gates:
      gateLlm: "Journey tests covering complete user flow must be present"
      gateCmd: "mix test test/journey/"
    inject: |
      Write journey tests in test/journey/.
  - name: api-contract-tests
    match:
      layer: api
    gates:
      gateCmd: "mix test test/contract/"
      verifyCmd: "mix openapi.validate"
`;

const LAYERS_ONLY_YAML = `
version: 1
layers:
  frontend:
    description: "UI components"
  backend:
    description: "Server logic"
`;

const EMPTY_POLICIES_YAML = `
version: 1
layers:
  frontend:
    description: "UI"
policies: []
`;

function makePolicies(): TaskPolicy[] {
	return [
		{
			name: "frontend-journey-tests",
			match: { layer: "frontend" },
			gates: { gateLlm: "Journey tests required", gateCmd: "mix test test/journey/" },
			inject: "Write journey tests.",
		},
		{
			name: "api-contract-tests",
			match: { layer: "api" },
			gates: { gateCmd: "mix test test/contract/" },
		},
		{
			name: "frontend-docs",
			match: { layer: "frontend" },
			gates: { verifyCmd: "mix docs" },
			inject: "Document the UI story.",
		},
	];
}

// Tests
// =============================================================================

describe("parseTaskPolicies", () => {
	it("parses valid YAML with layers and policies", () => {
		const config = parseTaskPolicies(VALID_YAML);
		expect(config).toBeDefined();
		expect(config!.version).toBe(1);
		expect(Object.keys(config!.layers)).toEqual(["frontend", "api", "infra"]);
		expect(config!.layers.frontend.description).toBe("LiveView pages, components, browser interactions");
		expect(config!.policies).toHaveLength(2);
		expect(config!.policies[0].name).toBe("frontend-journey-tests");
		expect(config!.policies[0].match.layer).toBe("frontend");
		expect(config!.policies[0].gates.gateLlm).toBe("Journey tests covering complete user flow must be present");
		expect(config!.policies[0].gates.gateCmd).toBe("mix test test/journey/");
		expect(config!.policies[0].inject).toContain("Write journey tests");
		expect(config!.policies[1].name).toBe("api-contract-tests");
		expect(config!.policies[1].gates.gateCmd).toBe("mix test test/contract/");
		expect(config!.policies[1].gates.verifyCmd).toBe("mix openapi.validate");
	});

	it("returns undefined for missing version field", () => {
		const result = parseTaskPolicies("layers:\n  frontend:\n    description: UI\n");
		expect(result).toBeUndefined();
	});

	it("ignores unknown gate fields", () => {
		const yaml = `
version: 1
policies:
  - name: test
    match:
      layer: frontend
    gates:
      gateCmd: "test"
      unknownGate: "should be ignored"
`;
		const config = parseTaskPolicies(yaml);
		expect(config).toBeDefined();
		expect(config!.policies[0].gates).toEqual({ gateCmd: "test" });
	});

	it("returns config with empty policies array", () => {
		const config = parseTaskPolicies(EMPTY_POLICIES_YAML);
		expect(config).toBeDefined();
		expect(config!.policies).toEqual([]);
		expect(config!.layers.frontend.description).toBe("UI");
	});

	it("returns config with layers only when no policies key", () => {
		const config = parseTaskPolicies(LAYERS_ONLY_YAML);
		expect(config).toBeDefined();
		expect(config!.policies).toEqual([]);
		expect(Object.keys(config!.layers)).toEqual(["frontend", "backend"]);
	});

	it("returns undefined for invalid YAML", () => {
		const result = parseTaskPolicies("{{{{invalid yaml");
		expect(result).toBeUndefined();
	});

	it("skips policies without valid match.layer", () => {
		const yaml = `
version: 1
policies:
  - name: bad-policy
    gates:
      gateCmd: "test"
  - name: good-policy
    match:
      layer: frontend
    gates:
      gateCmd: "test"
`;
		const config = parseTaskPolicies(yaml);
		expect(config).toBeDefined();
		expect(config!.policies).toHaveLength(1);
		expect(config!.policies[0].name).toBe("good-policy");
	});
});

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
			{ name: "frontend-tests", match: { layer: "frontend" }, gates: { gateCmd: "project-cmd" } },
			{ name: "api-tests", match: { layer: "api" }, gates: { gateCmd: "api-cmd" } },
		],
	};

	it("mode policy with same name overrides project policy", () => {
		const modePolicies: TaskPolicy[] = [
			{ name: "frontend-tests", match: { layer: "frontend" }, gates: { gateCmd: "mode-cmd" } },
		];
		const merged = mergePolicies(projectConfig, modePolicies);
		expect(merged.policies).toHaveLength(2);
		const frontendPolicy = merged.policies.find(p => p.name === "frontend-tests");
		expect(frontendPolicy!.gates.gateCmd).toBe("mode-cmd");
	});

	it("mode policy with different name accumulates", () => {
		const modePolicies: TaskPolicy[] = [
			{ name: "frontend-docs", match: { layer: "frontend" }, gates: { gateLlm: "docs required" } },
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
		const modePolicies: TaskPolicy[] = [{ name: "test", match: { layer: "frontend" }, gates: { gateCmd: "cmd" } }];
		const merged = mergePolicies(undefined, modePolicies);
		expect(merged.policies).toHaveLength(1);
		expect(merged.policies[0].name).toBe("test");
	});
});

describe("resolveGates", () => {
	const policies = makePolicies();

	it("returns merged gates for frontend layer", () => {
		const gates = resolveGates("frontend", policies);
		expect(gates.gateLlm).toBe("Journey tests required");
		expect(gates.gateCmd).toBe("mix test test/journey/");
		expect(gates.verifyCmd).toBe("mix docs");
	});

	it("accumulates gates from multiple matching policies", () => {
		// frontend-journey-tests provides gateLlm + gateCmd
		// frontend-docs provides verifyCmd
		const gates = resolveGates("frontend", policies);
		expect(gates.gateLlm).toBeDefined();
		expect(gates.gateCmd).toBeDefined();
		expect(gates.verifyCmd).toBeDefined();
	});

	it("last match wins when multiple policies set same gate", () => {
		const dupes: TaskPolicy[] = [
			{ name: "a", match: { layer: "frontend" }, gates: { gateCmd: "first" } },
			{ name: "b", match: { layer: "frontend" }, gates: { gateCmd: "second" } },
		];
		const gates = resolveGates("frontend", dupes);
		expect(gates.gateCmd).toBe("second");
	});

	it("returns empty gates for unmatched layer", () => {
		const gates = resolveGates("unknown", policies);
		expect(gates).toEqual({});
	});
});

describe("applyPolicyGates", () => {
	const policies = makePolicies();

	it("fills in missing gate fields from policy", () => {
		const existing: TaskPolicyGates = {};
		const result = applyPolicyGates(existing, "frontend", policies);
		expect(result.gateLlm).toBe("Journey tests required");
		expect(result.gateCmd).toBe("mix test test/journey/");
	});

	it("preserves existing explicit gates over policy defaults", () => {
		const existing: TaskPolicyGates = { gateCmd: "explicit-cmd" };
		const result = applyPolicyGates(existing, "frontend", policies);
		expect(result.gateCmd).toBe("explicit-cmd");
		expect(result.gateLlm).toBe("Journey tests required");
	});

	it("returns existing gates when no matching policies", () => {
		const existing: TaskPolicyGates = { gateCmd: "mine" };
		const result = applyPolicyGates(existing, "unknown", policies);
		expect(result.gateCmd).toBe("mine");
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
