import { describe, expect, it } from "bun:test";
import { classifyContextPressure } from "../../src/tools/context-pressure-policy";

describe("read routing policy", () => {
	it("routes untargeted source reads toward code/lsp instead of raw browsing", () => {
		const meta = classifyContextPressure({
			toolName: "read",
			params: { path: "packages/coding-agent/src/tools/read.ts" },
		});

		expect(meta?.category).toBe("source-exploration");
		expect(meta?.presentation).toBe("summary-first");
		expect(meta?.persistence).toBe("summary-only");
		expect(meta?.summary).toContain("code/lsp");
		expect(meta?.followUp[0]).toContain("code/lsp");
	});

	it("keeps explicit source ranges in precision mode", () => {
		const meta = classifyContextPressure({
			toolName: "read",
			params: { path: "packages/coding-agent/src/tools/read.ts", offset: 10, limit: 5 },
		});

		expect(meta?.category).toBe("precision");
		expect(meta?.presentation).toBe("inline");
		expect(meta?.persistence).toBe("allow-raw");
	});

	it("treats transcript and jobs reads as digest-first spelunking", () => {
		const sessionMeta = classifyContextPressure({
			toolName: "read",
			params: { path: "/repo/.spell/agent/sessions/recent.jsonl" },
		});
		const jobsMeta = classifyContextPressure({
			toolName: "read",
			params: { path: "jobs://job-123" },
		});

		expect(sessionMeta?.category).toBe("transcript-spelunking");
		expect(sessionMeta?.presentation).toBe("summary-first");
		expect(sessionMeta?.persistence).toBe("deny-raw");
		expect(sessionMeta?.summary).toContain("Raw body suppressed");
		expect(jobsMeta?.category).toBe("transcript-spelunking");
		expect(jobsMeta?.summary).toContain("jobs://");
	});
});
