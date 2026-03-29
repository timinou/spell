import { beforeEach, describe, expect, it } from "bun:test";
import type { BrowseFinding } from "../../src/modes/browse-findings";
import { BrowseEventMapper } from "../../src/modes/browse-event-mapper";
import type { AgentSessionEvent } from "../../src/session/agent-session";

const ev = (event: unknown) => event as AgentSessionEvent;

describe("BrowseEventMapper", () => {
	let mapper: BrowseEventMapper;
	let additionalEvents: Record<string, unknown>[];

	beforeEach(() => {
		mapper = new BrowseEventMapper();
		additionalEvents = [];
		mapper.onAdditionalEvent = event => {
			additionalEvents.push(event);
		};
	});

	it("maps custom finding messages on message_end", () => {
		const result = mapper.map(
			ev({
				type: "message_end",
				message: {
					role: "custom",
					customType: "finding",
					content: "",
					display: true,
					details: {
						id: "finding-1",
						url: "https://example.com/research/alpha",
						title: "Alpha finding",
						excerpt: "Short excerpt",
						tags: ["alpha", "source"],
						tabId: "research-1",
						timestamp: 123,
					},
					timestamp: 123,
				},
			}),
		);

		expect(result).toEqual({
			type: "finding",
			id: "finding-1",
			url: "https://example.com/research/alpha",
			title: "Alpha finding",
			excerpt: "Short excerpt",
			tags: ["alpha", "source"],
			sourceType: "agent",
			curated: true,
			enriched: false,
			tabId: "research-1",
			timestamp: 123,
		});
	});

	it("ignores malformed custom finding details", () => {
		const result = mapper.map(
			ev({
				type: "message_end",
				message: {
					role: "custom",
					customType: "finding",
					content: "",
					display: true,
					details: { url: "https://example.com/no-title" },
					timestamp: 123,
				},
			}),
		);

		expect(result).toBeNull();
	});

	describe("tool interception: web_search", () => {
		function simulateWebSearch(sources: unknown[], query = "test query") {
			// Emit start to populate pending map
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-ws-1",
					toolName: "web_search",
					intent: "Searching",
					args: { query },
				}),
			);

			// Emit end with sources
			return mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-ws-1",
					toolName: "web_search",
					isError: false,
					result: {
						content: [{ type: "text", text: "Results..." }],
						details: {
							response: { sources },
						},
					},
				}),
			);
		}

		it("emits findings_batch with one finding per SearchSource", () => {
			const sources = [
				{ title: "Result A", url: "https://a.com", snippet: "Snippet A" },
				{ title: "Result B", url: "https://b.com", snippet: "Snippet B" },
			];

			const toolEnd = simulateWebSearch(sources);

			// Normal tool_end should still be emitted
			expect(toolEnd).toMatchObject({ type: "tool_end", id: "call-ws-1" });

			// findings_batch emitted via callback
			expect(additionalEvents).toHaveLength(1);
			const batch = additionalEvents[0];
			expect(batch.type).toBe("findings_batch");
			expect(batch.searchGroup).toEqual({ query: "test query", toolCallId: "call-ws-1" });

			const findings = batch.findings as BrowseFinding[];
			expect(findings).toHaveLength(2);
			expect(findings[0].url).toBe("https://a.com");
			expect(findings[0].title).toBe("Result A");
			expect(findings[0].excerpt).toBe("Snippet A");
			expect(findings[0].sourceType).toBe("search");
			expect(findings[0].curated).toBe(false);
			expect(findings[1].url).toBe("https://b.com");
		});

		it("emits empty batch for zero sources", () => {
			simulateWebSearch([]);

			expect(additionalEvents).toHaveLength(1);
			const findings = additionalEvents[0].findings as BrowseFinding[];
			expect(findings).toHaveLength(0);
		});

		it("skips sources without URL", () => {
			simulateWebSearch([
				{ title: "No URL", url: "", snippet: "x" },
				{ title: "Has URL", url: "https://c.com", snippet: "y" },
			]);

			const findings = additionalEvents[0].findings as BrowseFinding[];
			expect(findings).toHaveLength(1);
			expect(findings[0].url).toBe("https://c.com");
		});

		it("falls through on isError=true without emitting findings", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-ws-err",
					toolName: "web_search",
					intent: "Searching",
					args: { query: "fail" },
				}),
			);

			const result = mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-ws-err",
					toolName: "web_search",
					isError: true,
					result: {
						content: [{ type: "text", text: "Error" }],
						details: { response: { sources: [{ title: "X", url: "https://x.com" }] } },
					},
				}),
			);

			expect(additionalEvents).toHaveLength(0);
			expect(result).toMatchObject({ type: "tool_end", isError: true });
		});

		it("falls through when details.error is set", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-ws-de",
					toolName: "web_search",
					intent: "Searching",
					args: { query: "fail" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-ws-de",
					toolName: "web_search",
					isError: false,
					result: {
						content: [],
						details: { error: "Provider timeout", response: { sources: [] } },
					},
				}),
			);

			expect(additionalEvents).toHaveLength(0);
		});

		it("falls through when details.response is undefined", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-ws-nr",
					toolName: "web_search",
					intent: "Searching",
					args: { query: "no response" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-ws-nr",
					toolName: "web_search",
					isError: false,
					result: { content: [], details: {} },
				}),
			);

			expect(additionalEvents).toHaveLength(0);
		});

		it("falls through when result.details is undefined", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-ws-nd",
					toolName: "web_search",
					intent: "Searching",
					args: { query: "no details" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-ws-nd",
					toolName: "web_search",
					isError: false,
					result: { content: [] },
				}),
			);

			expect(additionalEvents).toHaveLength(0);
		});
	});

	describe("tool interception: code_search", () => {
		it("emits findings_batch with code sources", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-cs-1",
					toolName: "code_search",
					intent: "Searching code",
					args: { query: "useState" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-cs-1",
					toolName: "code_search",
					isError: false,
					result: {
						content: [{ type: "text", text: "Code results" }],
						details: {
							response: {
								sources: [
									{
										title: "hooks.ts",
										url: "https://github.com/repo/file",
										repository: "myrepo",
										path: "src/hooks.ts",
										branch: "main",
										snippet: "const [state] = useState()",
									},
								],
							},
						},
					},
				}),
			);

			expect(additionalEvents).toHaveLength(1);
			const batch = additionalEvents[0];
			expect(batch.type).toBe("findings_batch");
			expect(batch.searchGroup).toBeNull();

			const findings = batch.findings as BrowseFinding[];
			expect(findings).toHaveLength(1);
			expect(findings[0].sourceType).toBe("code_search");
			expect(findings[0].curated).toBe(false);
			expect(findings[0].title).toBe("hooks.ts");
		});

		it("uses repository/path as title fallback when title is empty", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-cs-2",
					toolName: "code_search",
					intent: "Searching code",
					args: { query: "foo" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-cs-2",
					toolName: "code_search",
					isError: false,
					result: {
						content: [],
						details: {
							response: {
								sources: [
									{
										title: "",
										url: "https://github.com/org/repo/blob/main/lib/foo.ts",
										repository: "org/repo",
										path: "lib/foo.ts",
										branch: "main",
									},
								],
							},
						},
					},
				}),
			);

			const findings = additionalEvents[0].findings as BrowseFinding[];
			expect(findings[0].title).toBe("org/repo/lib/foo.ts");
		});

		it("falls through when details.error is set", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-cs-err",
					toolName: "code_search",
					intent: "Searching code",
					args: { query: "fail" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-cs-err",
					toolName: "code_search",
					isError: false,
					result: { content: [], details: { error: "Provider error" } },
				}),
			);

			expect(additionalEvents).toHaveLength(0);
		});
	});

	describe("tool interception: fetch", () => {
		it("emits single uncurated finding with sourceType fetch", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-f-1",
					toolName: "fetch",
					intent: "Fetching",
					args: { url: "https://docs.example.com/guide" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-f-1",
					toolName: "fetch",
					isError: false,
					result: {
						content: [{ type: "text", text: "# Guide\nSome content here" }],
						details: {
							url: "https://docs.example.com/guide",
							finalUrl: "https://docs.example.com/guide",
							contentType: "text/html",
							method: "GET",
							truncated: false,
							notes: [],
						},
					},
				}),
			);

			expect(additionalEvents).toHaveLength(1);
			const batch = additionalEvents[0];
			expect(batch.type).toBe("findings_batch");
			expect(batch.searchGroup).toBeNull();

			const findings = batch.findings as BrowseFinding[];
			expect(findings).toHaveLength(1);
			expect(findings[0].sourceType).toBe("fetch");
			expect(findings[0].curated).toBe(false);
			expect(findings[0].url).toBe("https://docs.example.com/guide");
			expect(findings[0].title).toBe("docs.example.com");
			expect(findings[0].contentBody).toBe("# Guide\nSome content here");
		});

		it("truncates contentBody to 10KB", () => {
			const longContent = "x".repeat(20000);
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-f-2",
					toolName: "fetch",
					intent: "Fetching",
					args: { url: "https://big.com" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-f-2",
					toolName: "fetch",
					isError: false,
					result: {
						content: [{ type: "text", text: longContent }],
						details: { url: "https://big.com", finalUrl: "https://big.com" },
					},
				}),
			);

			const findings = additionalEvents[0].findings as BrowseFinding[];
			expect(findings[0].contentBody!.length).toBe(10240);
		});

		it("falls through when finalUrl is empty", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-f-3",
					toolName: "fetch",
					intent: "Fetching",
					args: { url: "" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-f-3",
					toolName: "fetch",
					isError: false,
					result: {
						content: [{ type: "text", text: "content" }],
						details: { url: "", finalUrl: "" },
					},
				}),
			);

			expect(additionalEvents).toHaveLength(0);
		});

		it("falls through on isError=true", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-f-err",
					toolName: "fetch",
					intent: "Fetching",
					args: { url: "https://fail.com" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-f-err",
					toolName: "fetch",
					isError: true,
					result: {
						content: [{ type: "text", text: "Failed" }],
						details: { url: "https://fail.com", finalUrl: "https://fail.com" },
					},
				}),
			);

			expect(additionalEvents).toHaveLength(0);
		});
	});

	describe("start-end correlation", () => {
		it("retrieves query from tool_execution_start args", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-corr-1",
					toolName: "web_search",
					intent: "Searching for quantum computing",
					args: { query: "quantum computing breakthroughs" },
				}),
			);

			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-corr-1",
					toolName: "web_search",
					isError: false,
					result: {
						content: [{ type: "text", text: "Results" }],
						details: {
							response: { sources: [{ title: "QC Paper", url: "https://qc.com" }] },
						},
					},
				}),
			);

			const batch = additionalEvents[0];
			expect((batch.searchGroup as { query: string }).query).toBe("quantum computing breakthroughs");
		});

		it("cleans pending calls on agent_end", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-orphan",
					toolName: "web_search",
					intent: "Searching",
					args: { query: "orphan" },
				}),
			);

			// Agent ends before tool completes
			mapper.map(ev({ type: "agent_end" }));

			// Now the tool_end arrives but has no pending entry
			mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-orphan",
					toolName: "web_search",
					isError: false,
					result: {
						content: [],
						details: { response: { sources: [{ title: "X", url: "https://x.com" }] } },
					},
				}),
			);

			// No findings emitted because the pending entry was cleaned
			expect(additionalEvents).toHaveLength(0);
		});
	});

	describe("unknown tool names", () => {
		it("passes through to super.map for unintercepted tools", () => {
			mapper.map(
				ev({
					type: "tool_execution_start",
					toolCallId: "call-other",
					toolName: "edit",
					intent: "Editing",
					args: {},
				}),
			);

			const result = mapper.map(
				ev({
					type: "tool_execution_end",
					toolCallId: "call-other",
					toolName: "edit",
					isError: false,
					result: { content: [{ type: "text", text: "Done" }] },
				}),
			);

			expect(result).toMatchObject({ type: "tool_end", id: "call-other", name: "edit" });
			expect(additionalEvents).toHaveLength(0);
		});
	});

	describe("agent-curated finding", () => {
		it("sets curated=true on finding from customType=finding message", () => {
			const result = mapper.map(
				ev({
					type: "message_end",
					message: {
						role: "custom",
						customType: "finding",
						content: "",
						display: true,
						details: {
							url: "https://example.com/curated",
							title: "Agent curated finding",
							sourceType: "agent",
							curated: false, // Agent sent false, but we override to true
						},
						timestamp: 100,
					},
				}),
			);

			expect(result).toMatchObject({
				type: "finding",
				curated: true,
			});
		});
	});
});
