import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SwarmBlackboard } from "../../src/swarm/blackboard";
import { createHandoffTool } from "../../src/swarm/handoff-tool";
import type { SwarmEventMap } from "../../src/swarm/types";
import { FakeEventBus } from "../../src/utils/fake-event-bus";

function makeOrgConfig() {
	return {
		dirs: {
			swarm: {
				path: "!tasks/swarm",
				categories: {
					blackboard: { prefix: "SWB", path: "blackboard", writeInitialPrompt: false },
				},
			},
		},
		emacsPath: undefined,
		todoKeywords: ["INIT", "ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"],
		requiredProperties: ["AGENT", "TYPE"],
	};
}

describe("handoff tool", () => {
	test("records handoff context and emits the swarm handoff signal", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spell-handoff-"));
		const bus = new FakeEventBus<SwarmEventMap>();
		const blackboard = new SwarmBlackboard({ projectRoot, orgConfig: makeOrgConfig(), eventBus: bus });
		await blackboard.open({ sessionId: "sess-1", agent: "main", title: "Swarm Run" });

		const tool = createHandoffTool({
			active: true,
			agent: "main",
			sessionId: "sess-1",
			currentTaskUri: "task://sess-1/main/task-3",
			blackboard,
			eventBus: bus,
		});

		const result = await tool.execute(
			"call-1",
			{ context: "Take over here", target: "reviewer" },
			undefined,
			{} as never,
		);
		const first = result.content[0];

		expect(first?.type).toBe("text");
		expect(first && first.type === "text" ? first.text : "").toContain("Recorded handoff");
		expect(bus.emittedFor("swarm:handoff")).toEqual([
			{ fromAgent: "main", toAgent: "reviewer", context: "Take over here" },
		]);
		const entries = await blackboard.read({ type: "lifecycle" });
		expect(entries.at(-1)?.body).toContain("Take over here");
		expect(entries.at(-1)?.body).toContain("Target: reviewer");
	});

	test("rejects handoff outside swarm mode", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spell-handoff-"));
		const bus = new FakeEventBus<SwarmEventMap>();
		const blackboard = new SwarmBlackboard({ projectRoot, orgConfig: makeOrgConfig(), eventBus: bus });
		const tool = createHandoffTool({
			active: false,
			agent: "main",
			sessionId: "sess-1",
			blackboard,
			eventBus: bus,
		});
		await expect(tool.execute("call-2", { context: "nope" }, undefined, {} as never)).rejects.toThrow(
			"handoff tool is only available in swarm mode",
		);
	});
});
