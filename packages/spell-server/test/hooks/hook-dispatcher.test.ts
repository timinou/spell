import { describe, expect, it, vi } from "bun:test";
import { logger } from "@spell/pi-utils";
import type { GoalResult } from "../../src/executor";
import { type HookContext, HookDispatcher, type HookExecutor } from "../../src/hooks";
import type { HookTarget, ManifestHookConfig } from "../../src/manifest";

const BASE_RESULT: GoalResult = {
	goalName: "nightly",
	status: "success",
	duration: 250,
	runs: [],
	summary: "done",
};

class RecordingExecutor implements HookExecutor {
	readonly calls: Array<{ target: HookTarget; result: GoalResult; context: HookContext }> = [];
	#impl?: (target: HookTarget, result: GoalResult, context: HookContext) => Promise<void>;

	constructor(impl?: (target: HookTarget, result: GoalResult, context: HookContext) => Promise<void>) {
		this.#impl = impl;
	}

	async execute(target: HookTarget, result: GoalResult, context: HookContext): Promise<void> {
		this.calls.push({ target, result, context });
		await this.#impl?.(target, result, context);
	}
}

function createDispatcher(executor: HookExecutor): HookDispatcher {
	return new HookDispatcher(
		new Map([
			["webhook", executor],
			["telegram", executor],
			["org", executor],
		]),
	);
}

function createHooks(): ManifestHookConfig {
	return {
		onSuccess: [{ type: "webhook", url: "https://example.com/success" }],
		onFailure: [{ type: "telegram", chatId: 42 }],
		onComplete: [{ type: "org", category: "BUG" }],
	};
}

describe("HookDispatcher", () => {
	it("fires onSuccess hooks only for successful results", async () => {
		const executor = new RecordingExecutor();
		const dispatcher = createDispatcher(executor);

		await dispatcher.dispatch("nightly", BASE_RESULT, createHooks());

		expect(executor.calls).toHaveLength(2);
		expect(executor.calls[0]?.target.type).toBe("webhook");
		expect(executor.calls[1]?.target.type).toBe("org");
	});

	it("fires onFailure hooks only for failed results", async () => {
		const executor = new RecordingExecutor();
		const dispatcher = createDispatcher(executor);
		const result: GoalResult = { ...BASE_RESULT, status: "failure", error: "boom" };

		await dispatcher.dispatch("nightly", result, createHooks());

		expect(executor.calls).toHaveLength(2);
		expect(executor.calls[0]?.target.type).toBe("telegram");
		expect(executor.calls[1]?.target.type).toBe("org");
	});

	it("fires onComplete hooks regardless of status", async () => {
		const successExecutor = new RecordingExecutor();
		const failureExecutor = new RecordingExecutor();
		const hooks = { onComplete: [{ type: "org", category: "BUG" }] } satisfies ManifestHookConfig;

		await createDispatcher(successExecutor).dispatch("nightly", BASE_RESULT, hooks);
		await createDispatcher(failureExecutor).dispatch(
			"nightly",
			{ ...BASE_RESULT, status: "failure", error: "boom" },
			hooks,
		);

		expect(successExecutor.calls).toHaveLength(1);
		expect(failureExecutor.calls).toHaveLength(1);
	});

	it("fires multiple hooks in order", async () => {
		const executor = new RecordingExecutor();
		const dispatcher = createDispatcher(executor);
		const hooks: ManifestHookConfig = {
			onSuccess: [
				{ type: "webhook", url: "https://example.com/1" },
				{ type: "telegram", chatId: 1 },
				{ type: "org", category: "BUG" },
			],
		};

		await dispatcher.dispatch("nightly", BASE_RESULT, hooks);

		expect(executor.calls.map(call => call.target.type)).toEqual(["webhook", "telegram", "org"]);
	});

	it("continues after a hook failure", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const executor = new RecordingExecutor(async target => {
			if (target.type === "webhook") {
				throw new Error("fail first");
			}
		});
		const dispatcher = createDispatcher(executor);
		const hooks: ManifestHookConfig = {
			onSuccess: [
				{ type: "webhook", url: "https://example.com/1" },
				{ type: "telegram", chatId: 2 },
			],
		};

		await dispatcher.dispatch("nightly", BASE_RESULT, hooks);

		expect(executor.calls.map(call => call.target.type)).toEqual(["webhook", "telegram"]);
		expect(errorSpy).toHaveBeenCalledWith("Hook execution failed", { type: "webhook", error: "Error: fail first" });
	});

	it("ignores empty or undefined hook config", async () => {
		const executor = new RecordingExecutor();
		const dispatcher = createDispatcher(executor);

		await dispatcher.dispatch("nightly", BASE_RESULT, undefined);
		await dispatcher.dispatch("nightly", BASE_RESULT, {});

		expect(executor.calls).toHaveLength(0);
	});
});
