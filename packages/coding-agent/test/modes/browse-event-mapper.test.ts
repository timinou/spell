import { beforeEach, describe, expect, it } from "bun:test";
import { BrowseEventMapper } from "../../src/modes/browse-event-mapper";
import type { AgentSessionEvent } from "../../src/session/agent-session";

const ev = (event: unknown) => event as AgentSessionEvent;

describe("BrowseEventMapper", () => {
	let mapper: BrowseEventMapper;

	beforeEach(() => {
		mapper = new BrowseEventMapper();
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
});
