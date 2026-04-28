import { describe, expect, it } from "bun:test";
import type { AutonomyManifest } from "../../src/manifest/types";
import { AutonomyLifecycle } from "../../src/session";

function emptyManifest(): AutonomyManifest {
	return {
		name: "test",
		version: "1.0.0",
		setups: new Map(),
		goals: new Map(),
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
	};
}

describe("session lifecycles", () => {
	it("AutonomyLifecycle returns no idle timeout", () => {
		const lifecycle = new AutonomyLifecycle(emptyManifest());
		expect(lifecycle.getIdleTimeout("nightly-tests")).toBeNull();
	});

	it("AutonomyLifecycle adds autonomy_state tool", () => {
		const lifecycle = new AutonomyLifecycle(emptyManifest());
		const options = lifecycle.buildSpawnOptions("nightly-tests", {
			cwd: "/tmp/project",
			tools: ["read", "grep"],
			appendSystemPrompt: "prompt",
			sessionDir: "/tmp/sessions",
			sandboxPolicyPath: "/tmp/policy.json",
		});

		expect(options).toEqual({
			cwd: "/tmp/project",
			tools: ["read", "grep", "autonomy_state"],
			appendSystemPrompt: "prompt",
			sessionDir: "/tmp/sessions",
			sandboxPolicyPath: "/tmp/policy.json",
		});
	});
});
