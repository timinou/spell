import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SwarmBlackboard } from "../../src/swarm/blackboard";
import type { SwarmEventMap } from "../../src/swarm/types";
import { FakeEventBus } from "../../src/utils/fake-event-bus";

function makeOrgConfig() {
	return {
		dirs: {
			swarm: {
				path: "!tasks/swarm",
				categories: {
					blackboard: {
						prefix: "SWB",
						path: "blackboard",
						writeInitialPrompt: false,
					},
				},
			},
		},
		emacsPath: undefined,
		todoKeywords: ["INIT", "ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"],
		requiredProperties: ["AGENT", "TYPE"],
	};
}

describe("SwarmBlackboard", () => {
	test("bridges data URIs to swarm:artifact after a successful write", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spell-blackboard-"));
		const bus = new FakeEventBus<SwarmEventMap>();
		const blackboard = new SwarmBlackboard({ projectRoot, orgConfig: makeOrgConfig(), eventBus: bus });

		await blackboard.open({ sessionId: "sess-1", agent: "main", title: "Swarm Run" });
		const entry = await blackboard.write({
			type: "artifact",
			agent: "main",
			title: "Published data",
			body: "artifact body",
			dataUri: "data://sess-1/main/artifacts/result",
		});

		expect(entry.agent).toBe("main");
		expect(entry.type).toBe("artifact");
		expect(bus.emittedFor("swarm:artifact")).toEqual([
			{
				runId: "SWARM-sess-1",
				entryId: entry.id,
				agent: "main",
				dataUri: "data://sess-1/main/artifacts/result",
				type: "artifact",
			},
		]);
	});

	test("does not emit artifact events without DATA_URI and preserves metadata in reads", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spell-blackboard-"));
		const bus = new FakeEventBus<SwarmEventMap>();
		const blackboard = new SwarmBlackboard({ projectRoot, orgConfig: makeOrgConfig(), eventBus: bus });

		await blackboard.open({ sessionId: "sess-2", agent: "main", title: "Swarm Run" });
		await blackboard.write({
			type: "finding",
			agent: "alpha",
			title: "Finding A",
			body: "first finding",
		});
		await blackboard.write({
			type: "progress",
			agent: "beta",
			title: "Progress B",
			body: "second progress",
		});

		expect(bus.emittedFor("swarm:artifact")).toEqual([]);
		const all = await blackboard.read();
		expect(all.map(item => ({ agent: item.agent, type: item.type, title: item.title }))).toEqual([
			{ agent: "main", type: "lifecycle", title: "Swarm Run" },
			{ agent: "alpha", type: "finding", title: "Finding A" },
			{ agent: "beta", type: "progress", title: "Progress B" },
		]);
		expect(await blackboard.read({ agent: "alpha" })).toHaveLength(1);
		expect(await blackboard.read({ type: "progress" })).toHaveLength(1);
	});

	test("surfaces org write failures before any artifact emission", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spell-blackboard-"));
		const bus = new FakeEventBus<SwarmEventMap>();
		const blackboard = new SwarmBlackboard({ projectRoot, orgConfig: makeOrgConfig(), eventBus: bus });

		await expect(
			blackboard.write({
				type: "artifact",
				agent: "main",
				title: "Should fail",
				body: "no run open",
				dataUri: "data://sess-3/main/artifacts/result",
			}),
		).rejects.toThrow(/blackboard not opened/);
		expect(bus.emittedFor("swarm:artifact")).toEqual([]);
	});
});
