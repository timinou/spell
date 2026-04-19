import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { convertToLlm } from "../../src/session/messages";
import { classifyContextPressure, createMemorySafeToolResult } from "../../src/tools/context-pressure-policy";

function createToolResult(
	overrides: Partial<ToolResultMessage<unknown>> & { toolName: string },
): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: overrides.toolCallId ?? "call-1",
		toolName: overrides.toolName,
		content: overrides.content ?? [{ type: "text", text: "result" }],
		details: overrides.details,
		isError: overrides.isError ?? false,
		attribution: overrides.attribution,
		prunedAt: overrides.prunedAt,
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

describe("context-pressure policy", () => {
	it("classifies transcript spelunking for read and grep", () => {
		const readMeta = classifyContextPressure({
			toolName: "read",
			params: { path: "/repo/.spell/agent/sessions/recent.jsonl" },
		});
		const grepMeta = classifyContextPressure({
			toolName: "grep",
			params: { pattern: "toolResult", path: "/repo/.spell/agent/sessions/recent.jsonl" },
		});

		expect(readMeta?.category).toBe("transcript-spelunking");
		expect(grepMeta?.category).toBe("transcript-spelunking");
		expect(readMeta?.persistence).toBe("deny-raw");
		expect(grepMeta?.persistence).toBe("deny-raw");
		expect(readMeta?.presentation).toBe("summary-first");
		expect(grepMeta?.presentation).toBe("summary-first");
	});

	it("keeps bash output inline when it fit the inline budget", () => {
		const meta = classifyContextPressure({
			toolName: "bash",
			params: { command: "git status --short" },
		});

		expect(meta?.category).toBe("other");
		expect(meta?.presentation).toBe("inline");
		expect(meta?.persistence).toBe("allow-raw");
	});

	it("marks bash summary-first only when output spilled to an artifact", () => {
		const spilled = classifyContextPressure({
			toolName: "bash",
			params: { command: "cat ./large-log.txt" },
			detailsMeta: { truncation: { artifactUri: "artifact://session/main/bash/0.txt" } },
		});

		expect(spilled?.category).toBe("other");
		expect(spilled?.presentation).toBe("summary-first");
		expect(spilled?.persistence).toBe("summary-only");
		expect(spilled?.summary).toContain("artifact://session/main/bash/0.txt");
	});

	it("downgrades bash errors to summary-only even when output fit inline", () => {
		const meta = classifyContextPressure({
			toolName: "bash",
			params: { command: "false" },
			isError: true,
		});

		expect(meta?.presentation).toBe("inline");
		expect(meta?.persistence).toBe("summary-only");
	});

	it("keeps explicit read ranges and narrow grep scopes in precision mode", () => {
		const readMeta = classifyContextPressure({
			toolName: "read",
			params: { path: "packages/coding-agent/src/tools/read.ts", offset: 50, limit: 20 },
		});
		const grepMeta = classifyContextPressure({
			toolName: "grep",
			params: { pattern: "OutputMeta", path: "packages/coding-agent/src/tools/output-meta.ts" },
		});

		expect(readMeta?.category).toBe("precision");
		expect(readMeta?.persistence).toBe("allow-raw");
		expect(grepMeta?.category).toBe("precision");
		expect(grepMeta?.persistence).toBe("allow-raw");
	});

	it("replaces spilled bash results with compact summaries for memory persistence", () => {
		const contextPressure = classifyContextPressure({
			toolName: "bash",
			params: { command: "cat ./large-log.txt" },
			detailsMeta: { truncation: { artifactUri: "artifact://session/main/bash/0.txt" } },
		});
		if (!contextPressure) throw new Error("expected context pressure classification");

		const raw = createToolResult({
			toolName: "bash",
			content: [{ type: "text", text: "a very long log body ..." }],
		});
		const safe = createMemorySafeToolResult(raw, contextPressure);
		if (!safe) throw new Error("expected memory-safe tool result");

		expect(safe.content).toEqual([{ type: "text", text: contextPressure.summary }]);
		expect(
			(safe.details as { meta?: { contextPressure?: { category?: string } } } | undefined)?.meta?.contextPressure
				?.category,
		).toBe("other");
	});

	it("preserves raw precision tool results while attaching policy metadata", () => {
		const contextPressure = classifyContextPressure({
			toolName: "read",
			params: { path: "packages/coding-agent/src/tools/read.ts", offset: 10, limit: 5 },
		});
		if (!contextPressure) throw new Error("expected precision classification");

		const raw = createToolResult({
			toolName: "read",
			content: [{ type: "text", text: "10:const read = true;" }],
		});
		const safe = createMemorySafeToolResult(raw, contextPressure);
		if (!safe) throw new Error("expected memory-safe tool result");

		expect(safe.content).toEqual(raw.content);
		expect(
			(safe.details as { meta?: { contextPressure?: { persistence?: string } } } | undefined)?.meta?.contextPressure
				?.persistence,
		).toBe("allow-raw");
	});

	it("uses compact summaries when pruned spilled bash results re-enter LLM history", () => {
		const contextPressure = classifyContextPressure({
			toolName: "bash",
			params: { command: "cat ./large-log.txt" },
			detailsMeta: { truncation: { artifactUri: "artifact://session/main/bash/0.txt" } },
		});
		if (!contextPressure) throw new Error("expected bash classification");

		const message = createToolResult({
			toolName: "bash",
			content: [{ type: "text", text: "a very long log body ..." }],
			details: { meta: { contextPressure } },
			prunedAt: 1,
		});
		const converted = convertToLlm([message]);
		const toolResult = converted[0];
		if (!toolResult || toolResult.role !== "toolResult") throw new Error("expected tool result message");

		expect(toolResult.content).toEqual([{ type: "text", text: contextPressure.summary }]);
	});
});
