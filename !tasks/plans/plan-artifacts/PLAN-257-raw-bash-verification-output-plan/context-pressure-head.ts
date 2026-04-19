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
	it("classifies transcript spelunking consistently across read, grep, and bash", () => {
		const readMeta = classifyContextPressure({
			toolName: "read",
			params: { path: "/repo/.spell/agent/sessions/recent.jsonl" },
		});
		const grepMeta = classifyContextPressure({
			toolName: "grep",
			params: { pattern: "toolResult", path: "/repo/.spell/agent/sessions/recent.jsonl" },
		});
		const bashMeta = classifyContextPressure({
			toolName: "bash",
			params: { command: "jq '.messages[]' /repo/.spell/agent/sessions/recent.jsonl" },
		});

		expect(readMeta?.category).toBe("transcript-spelunking");
		expect(grepMeta?.category).toBe("transcript-spelunking");
		expect(bashMeta?.category).toBe("transcript-spelunking");
		expect(readMeta?.persistence).toBe("deny-raw");
		expect(grepMeta?.persistence).toBe("deny-raw");
		expect(bashMeta?.persistence).toBe("deny-raw");
		expect(readMeta?.presentation).toBe("summary-first");
		expect(grepMeta?.presentation).toBe("summary-first");
		expect(bashMeta?.presentation).toBe("summary-first");
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

	it("classifies wait, verification, and git-inspection bash churn separately", () => {
		const waitMeta = classifyContextPressure({
			toolName: "bash",
			params: { command: "sleep 3" },
		});
		const verificationMeta = classifyContextPressure({
			toolName: "bash",
			params: { command: "bun test packages/coding-agent/test/tools/read-routing.test.ts" },
		});
		const gitMeta = classifyContextPressure({
			toolName: "bash",
			params: { command: "git diff --stat" },
		});

		expect(waitMeta?.category).toBe("state-polling");
		expect(waitMeta?.persistence).toBe("deny-raw");
		expect(verificationMeta?.category).toBe("verification");
		expect(verificationMeta?.persistence).toBe("summary-only");
		expect(gitMeta?.category).toBe("git-inspection");
		expect(gitMeta?.persistence).toBe("summary-only");
	});

	it("replaces low-value tool results with compact summaries for memory persistence", () => {
		const contextPressure = classifyContextPressure({
			toolName: "bash",
			params: { command: "sleep 1" },
		});
		if (!contextPressure) throw new Error("expected context pressure classification");

		const raw = createToolResult({
			toolName: "bash",
			content: [{ type: "text", text: "slept for 1 second\nno useful output" }],
		});
		const safe = createMemorySafeToolResult(raw, contextPressure);
		if (!safe) throw new Error("expected memory-safe tool result");

		expect(safe.content).toEqual([{ type: "text", text: contextPressure.summary }]);
		expect(
			(safe.details as { meta?: { contextPressure?: { category?: string } } } | undefined)?.meta?.contextPressure
				?.category,
		).toBe("state-polling");
	});

	it("compacts verification results for memory persistence while keeping metadata", () => {
		const contextPressure = classifyContextPressure({
			toolName: "bash",
			params: { command: "bun test packages/coding-agent/test/tools/read-routing.test.ts" },
		});
		if (!contextPressure) throw new Error("expected context pressure classification");

		const raw = createToolResult({
			toolName: "bash",
			content: [{ type: "text", text: "ok 1 test" }],
		});
		const safe = createMemorySafeToolResult(raw, contextPressure);
		if (!safe) throw new Error("expected memory-safe tool result");

		expect(safe.content).toEqual([{ type: "text", text: contextPressure.summary }]);
		expect(
			(safe.details as { meta?: { contextPressure?: { category?: string; persistence?: string } } } | undefined)
				?.meta?.contextPressure?.category,
		).toBe("verification");
		expect(
			(safe.details as { meta?: { contextPressure?: { category?: string; persistence?: string } } } | undefined)
				?.meta?.contextPressure?.persistence,
		).toBe("summary-only");
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

	it("uses compact verification summaries when pruned tool results re-enter LLM history", () => {
		const contextPressure = classifyContextPressure({
			toolName: "bash",
			params: { command: "bun test packages/coding-agent/test/tools/read-routing.test.ts" },
		});
		if (!contextPressure) throw new Error("expected bash verification classification");

		const message = createToolResult({
			toolName: "bash",
			content: [{ type: "text", text: "ok 1 test" }],
			details: { meta: { contextPressure } },
			prunedAt: 1,
		});
		const converted = convertToLlm([message]);
		const toolResult = converted[0];
		if (!toolResult || toolResult.role !== "toolResult") throw new Error("expected tool result message");

		expect(toolResult.content).toEqual([{ type: "text", text: contextPressure.summary }]);
	});
});
