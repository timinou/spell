import { afterEach, describe, expect, it } from "bun:test";
import type { ManifestGoal } from "../../../spell-server/src/manifest";
import {
	createGoal,
	createGoalRun,
	startWorkflowHttpServer,
} from "../../../spell-server/test/http/workflow-test-helpers";
import { Settings } from "../../src/config/settings";
import { createTools, type ToolSession } from "../../src/tools";
import { fetchGoalsToolView } from "../../src/tools/goals-tool";

let stop: (() => void) | undefined;
const originalSpellServerUrl = Bun.env.SPELL_SERVER_URL;
const originalSpellServerUsername = Bun.env.SPELL_SERVER_USERNAME;
const originalSpellServerPassword = Bun.env.SPELL_SERVER_PASSWORD;

function restoreEnv(
	name: "SPELL_SERVER_URL" | "SPELL_SERVER_USERNAME" | "SPELL_SERVER_PASSWORD",
	value: string | undefined,
): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

function createSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

afterEach(() => {
	stop?.();
	stop = undefined;
	restoreEnv("SPELL_SERVER_URL", originalSpellServerUrl);
	restoreEnv("SPELL_SERVER_USERNAME", originalSpellServerUsername);
	restoreEnv("SPELL_SERVER_PASSWORD", originalSpellServerPassword);
});

describe("goals tool client", () => {
	it("reads canonical goal summaries from spell-server", async () => {
		const goals = new Map<string, ManifestGoal>([
			["discover", createGoal({ action: { id: "spell.noop", params: {}, promptSlots: {} }, prompt: undefined })],
		]);
		const server = startWorkflowHttpServer({
			goals,
			states: { discover: "completed" },
			runs: { discover: [createGoalRun("discover", "completed")] },
		});
		stop = server.stop;

		expect(
			await fetchGoalsToolView({
				baseUrl: server.baseUrl,
				username: "spell",
				password: "secret", // pragma: allowlist secret
			}),
		).toEqual([expect.objectContaining({ name: "discover", actionId: "spell.noop", runCount: 1 })]);
	});

	it("registers the builtin tool when spell-server url is available", async () => {
		const goals = new Map<string, ManifestGoal>([
			["discover", createGoal({ action: { id: "spell.noop", params: {}, promptSlots: {} }, prompt: undefined })],
		]);
		const server = startWorkflowHttpServer({
			goals,
			states: { discover: "completed" },
			runs: { discover: [createGoalRun("discover", "completed")] },
		});
		stop = server.stop;
		Bun.env.SPELL_SERVER_URL = server.baseUrl;
		Bun.env.SPELL_SERVER_USERNAME = "spell";
		Bun.env.SPELL_SERVER_PASSWORD = "secret"; // pragma: allowlist secret

		const tools = await createTools(createSession(), ["goals"]);
		expect(tools.map(tool => tool.name)).toEqual(["goals", "exit_plan_mode"]);

		const goalsTool = tools.find(tool => tool.name === "goals");
		if (!goalsTool) throw new Error("Missing goals tool");
		const result = await goalsTool.execute("tool-call", {});
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining('"discover"') }),
		]);
	});

	it("does not register the builtin tool when spell-server url is unavailable", async () => {
		delete Bun.env.SPELL_SERVER_URL;
		delete Bun.env.SPELL_SERVER_USERNAME;
		delete Bun.env.SPELL_SERVER_PASSWORD;

		const tools = await createTools(createSession(), ["goals"]);
		expect(tools.map(tool => tool.name)).toEqual(["exit_plan_mode"]);
	});
});
