import { describe, expect, it } from "bun:test";

import type { InternalUrl } from "../../src/internal-urls/types";

import {
	buildTaskUri,
	canonicalizeTaskUri,
	isTaskShortReference,
	isTaskUri,
	isTaskUriScheme,
	parseTaskShortReference,
	parseTaskUri,
	resolveTaskUri,
} from "../../src/swarm/uri";

import { isTaskUriProtocol, TaskUriProtocolHandler } from "../../src/swarm/uri-protocol";

function makeUrl(input: string): URL {
	return new URL(input);
}

describe("swarm uri helpers", () => {
	it("parses and builds full task and data uris", () => {
		const task = parseTaskUri("task://sess-1/agent-a/task-3::child")!;
		expect(task).toEqual({ scheme: "task", sessionId: "sess-1", agentName: "agent-a", slug: "task-3::child" });
		expect(buildTaskUri(task)).toBe("task://sess-1/agent-a/task-3::child");

		const data = parseTaskUri("data://sess-1/agent-a/payload::sub")!;
		expect(data.scheme).toBe("data");
		expect(buildTaskUri(data)).toBe("data://sess-1/agent-a/payload::sub");
	});

	it("supports short task references and current-session canonicalization", () => {
		const shortRef = parseTaskShortReference("task-12::review", {
			currentSessionId: "sess-9",
			currentAgentName: "agent-x",
		});
		expect(shortRef).toEqual({ scheme: "task", sessionId: "sess-9", agentName: "agent-x", slug: "task-12::review" });
		expect(canonicalizeTaskUri("task-12::review", { currentSessionId: "sess-9", currentAgentName: "agent-x" })).toBe(
			"task://sess-9/agent-x/task-12::review",
		);

		expect(
			canonicalizeTaskUri("task://current/agent-x/task-12::review", {
				currentSessionId: "sess-9",
				currentAgentName: "agent-x",
			}),
		).toBe("task://sess-9/agent-x/task-12::review");
		expect(
			resolveTaskUri("task://current/agent-x/task-12::review", {
				currentSessionId: "sess-9",
				currentAgentName: "agent-x",
			}),
		).toEqual({ scheme: "task", sessionId: "sess-9", agentName: "agent-x", slug: "task-12::review" });
	});

	it("rejects malformed or wrong-scheme inputs and exposes scheme predicates", () => {
		expect(isTaskUri("task://sess/agent/slug")).toBe(true);
		expect(isTaskUri("data://sess/agent/slug")).toBe(true);
		expect(isTaskUri("agent://sess/agent/slug")).toBe(false);
		expect(isTaskShortReference("task-3::sub")).toBe(true);
		expect(isTaskShortReference("task://sess/agent/slug")).toBe(false);
		expect(isTaskUriScheme("task")).toBe(true);
		expect(isTaskUriScheme("data")).toBe(true);
		expect(isTaskUriScheme("agent")).toBe(false);
		expect(isTaskUriProtocol("task-3::sub")).toBe(true);
		expect(isTaskUriProtocol("task://sess/agent/slug")).toBe(true);
		expect(isTaskUriProtocol("agent://sess/agent/slug")).toBe(false);
		expect(parseTaskUri("task://sess-only")).toBeNull();
		expect(parseTaskUri("agent://sess/agent/slug")).toBeNull();
		expect(resolveTaskUri("task-3::sub", { currentSessionId: "sess-9" })).toBeNull();
	});

	it("returns truthful unresolved protocol results", async () => {
		const handler = new TaskUriProtocolHandler({
			scheme: "task",
			getCurrentSessionId: () => "sess-9",
			currentAgentName: "agent-x",
		});
		const resource = await handler.resolve(makeUrl("task://current/agent-x/task-3::sub") as InternalUrl);
		expect(resource.url).toBe("task://sess-9/agent-x/task-3::sub");
		expect(resource.contentType).toBe("application/json");
		expect(resource.notes).toContain("Task/data URI resolution is currently structural only.");
		expect(resource.content).toContain("Full task/data content resolution is deferred until DAG-native nodes land.");
	});
});
