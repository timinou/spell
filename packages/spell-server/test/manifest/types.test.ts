import { describe, expect, it } from "bun:test";
import { isValidGoal, isValidManifest, isValidSetup } from "../../src/manifest";

describe("manifest type guards", () => {
	it("isValidSetup accepts valid shape", () => {
		expect(
			isValidSetup({
				domain: "coding",
				mode: "reviewer",
				tools: { allow: ["read"], deny: ["bash"] },
				sandbox: { pathsWrite: ["src/"] },
				timeout: "30m",
				maxCostUsd: 4.5,
			}),
		).toBe(true);
	});

	it("isValidSetup rejects missing domain", () => {
		expect(isValidSetup({ mode: "reviewer" })).toBe(false);
	});

	it("isValidGoal accepts valid shape", () => {
		expect(
			isValidGoal({
				setup: "readonly-reviewer",
				schedule: { type: "cron", expression: "0 1 * * *" },
				prompt: "Run the test suite.",
				state: { persist: true, schema: [{ name: "summary", type: "string" }] },
			}),
		).toBe(true);
	});

	it("isValidGoal rejects missing prompt", () => {
		expect(
			isValidGoal({
				setup: "readonly-reviewer",
				schedule: { type: "cron", expression: "0 1 * * *" },
			}),
		).toBe(false);
	});

	it("isValidManifest accepts manifest with maps", () => {
		expect(
			isValidManifest({
				name: "spell",
				version: "1.0",
				setups: new Map([["readonly-reviewer", { domain: "coding" }]]),
				goals: new Map([
					[
						"nightly-tests",
						{
							setup: "readonly-reviewer",
							schedule: { type: "cron", expression: "0 1 * * *" },
							prompt: "Run tests",
						},
					],
				]),
				templates: new Map(),
				exportTargets: [],
				notificationRoutes: [],
				reviewPolicies: [],
				checkpoints: [],
				panels: [],
				layouts: [],
				syncCollections: [],
				stateSchemas: [],
				toolModules: [],
				operatorActions: [],
			}),
		).toBe(true);
	});
});
