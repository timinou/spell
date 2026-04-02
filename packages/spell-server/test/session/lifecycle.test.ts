import { describe, expect, it } from "bun:test";
import { AutonomyLifecycle, TelegramLifecycle } from "../../src/session";

describe("session lifecycles", () => {
	it("TelegramLifecycle returns configured idle timeout", () => {
		const lifecycle = new TelegramLifecycle(12_345);
		expect(lifecycle.getIdleTimeout("chat-1")).toBe(12_345);
	});

	it("AutonomyLifecycle returns no idle timeout", () => {
		const lifecycle = new AutonomyLifecycle();
		expect(lifecycle.getIdleTimeout("nightly-tests")).toBeNull();
	});

	it("AutonomyLifecycle adds autonomy_state tool", () => {
		const lifecycle = new AutonomyLifecycle();
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
