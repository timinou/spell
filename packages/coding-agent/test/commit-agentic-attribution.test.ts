import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { runCommitAgentSession } from "../src/commit/agentic/agent";
import * as toolsModule from "../src/commit/agentic/tools";
import { Settings } from "../src/config/settings";
import * as sdkModule from "../src/sdk";
import type { PromptOptions } from "../src/session/agent-session";

describe("commit agent prompt attribution", () => {
	beforeEach(() => {
		spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as never);
		spyOn(toolsModule, "createCommitTools").mockReturnValue([]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	const session = {
		prompt: async (text: string, options?: PromptOptions) => {
			prompts.push({ text, options });
		},
		subscribe: () => () => {},
		dispose: async () => {},
	};

	it("marks generated commit prompts and reminders as agent-attributed", async () => {
		prompts.length = 0;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 model to exist");
		}

		await runCommitAgentSession({
			cwd: "/tmp",
			git: {} as never,
			model,
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			authStorage: {} as never,
			changelogTargets: [],
			requireChangelog: false,
		});

		expect(prompts).toHaveLength(4);
		for (const prompt of prompts) {
			expect(prompt.options?.attribution).toBe("agent");
			expect(prompt.options?.expandPromptTemplates).toBe(false);
		}
	});
});
