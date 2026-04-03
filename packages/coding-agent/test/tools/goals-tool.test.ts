import { afterEach, describe, expect, it } from "bun:test";
import type { ManifestGoal } from "../../../spell-server/src/manifest";
import { fetchGoalsToolView } from "../../src/tools/goals-tool";
import {
	createGoal,
	createGoalRun,
	startWorkflowHttpServer,
} from "../../../spell-server/test/http/workflow-test-helpers";

let stop: (() => void) | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
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
});
