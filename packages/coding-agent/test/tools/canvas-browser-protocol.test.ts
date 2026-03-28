import { describe, expect, it } from "bun:test";
import {
	browserCommandActions,
	browserEventActions,
	classifyBrowserCommandIdempotency,
	classifyBrowserPayload,
	isBrowserCommandAction,
	isBrowserEventAction,
	tabCommandActions,
	tabEventActions,
} from "../../src/tools/canvas-browser-protocol";
import { classifyEvent } from "../../src/tools/canvas-event-utils";

type CanvasEvent = Parameters<typeof classifyEvent>[0];

function mkEvent(overrides: Partial<CanvasEvent> = {}): CanvasEvent {
	return { name: "", payload: {}, ...overrides };
}

describe("isBrowserCommandAction", () => {
	it("accepts all known browser command actions", () => {
		browserCommandActions.forEach(action => {
			expect(isBrowserCommandAction(action)).toBe(true);
		});
	});

	it("accepts tab commands through the shared command guard", () => {
		tabCommandActions.forEach(action => {
			expect(isBrowserCommandAction(action)).toBe(true);
		});
	});

	it("rejects unknown string actions", () => {
		expect(isBrowserCommandAction("browser:unknown")).toBe(false);
		expect(isBrowserCommandAction("not:a:browser:action")).toBe(false);
	});

	it("rejects non-string values", () => {
		expect(isBrowserCommandAction(123)).toBe(false);
		expect(isBrowserCommandAction(null)).toBe(false);
		expect(isBrowserCommandAction(undefined)).toBe(false);
		expect(isBrowserCommandAction({})).toBe(false);
	});

	it("rejects browser event actions", () => {
		expect(isBrowserCommandAction("browser:result")).toBe(false);
		expect(isBrowserCommandAction("browser:state")).toBe(false);
	});
});

describe("isBrowserEventAction", () => {
	it("accepts all known browser event actions", () => {
		browserEventActions.forEach(action => {
			expect(isBrowserEventAction(action)).toBe(true);
		});
	});

	it("accepts tab events through the shared event guard", () => {
		tabEventActions.forEach(action => {
			expect(isBrowserEventAction(action)).toBe(true);
		});
	});

	it("rejects unknown string actions", () => {
		expect(isBrowserEventAction("browser:unknown")).toBe(false);
		expect(isBrowserEventAction("not:an:event")).toBe(false);
	});

	it("rejects non-string values", () => {
		expect(isBrowserEventAction(123)).toBe(false);
		expect(isBrowserEventAction(null)).toBe(false);
		expect(isBrowserEventAction(undefined)).toBe(false);
		expect(isBrowserEventAction({})).toBe(false);
	});

	it("rejects browser command actions", () => {
		expect(isBrowserEventAction("browser:goto")).toBe(false);
		expect(isBrowserEventAction("browser:click")).toBe(false);
	});
});

describe("classifyBrowserPayload", () => {
	describe("silent events", () => {
		it("classifies browser:state as silent", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:state",
					state: "interactive",
				}),
			).toBe("silent");
		});

		it("classifies browser:url_changed as silent", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:url_changed",
					url: "https://example.com",
					title: "Example",
				}),
			).toBe("silent");
		});

		it("classifies browser:console without error level as silent", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:console",
					level: "log",
					message: "debug info",
					lineNumber: 42,
					sourceId: "script.js",
					silent: false,
				}),
			).toBe("silent");
		});

		it("classifies browser:console with info level as silent", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:console",
					level: "info",
					message: "test message",
					lineNumber: 1,
					sourceId: "test.js",
					silent: false,
				}),
			).toBe("silent");
		});

		it("classifies browser:console with warn level as silent", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:console",
					level: "warn",
					message: "warning message",
					lineNumber: 10,
					sourceId: "warn.js",
					silent: false,
				}),
			).toBe("silent");
		});

		it("respects payload.silent === true override", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:navigation_failed",
					url: "https://example.com",
					error: "network error",
					silent: true,
				}),
			).toBe("silent");
		});
	});

	describe("loud events", () => {
		it("classifies browser:result as loud", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:result",
					_rid: "req123",
					command: "browser:goto",
					ok: true,
					result: null,
					error: null,
					url: "https://example.com",
					title: "Example",
					state: "interactive",
				}),
			).toBe("loud");
		});

		it("classifies browser:navigation_failed as loud", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:navigation_failed",
					url: "https://example.com",
					error: "connection refused",
					errorCode: 5,
				}),
			).toBe("loud");
		});

		it("classifies browser:navigation_blocked as loud", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:navigation_blocked",
					url: "file:///etc/passwd",
					reason: "blocked by security policy",
					detail: {},
				}),
			).toBe("loud");
		});

		it("classifies browser:console with error level as loud", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:console",
					level: "error",
					message: "something went wrong",
					lineNumber: 100,
					sourceId: "app.js",
					silent: false,
				}),
			).toBe("loud");
		});

		it("classifies browser:console with Error (capitalized) level as loud", () => {
			expect(
				classifyBrowserPayload({
					action: "browser:console",
					level: "Error",
					message: "critical issue",
					lineNumber: 50,
					sourceId: "critical.js",
					silent: false,
				}),
			).toBe("loud");
		});
	});

	describe("non-browser payloads", () => {
		it("returns null for payloads without browser event action", () => {
			expect(classifyBrowserPayload({ action: "something:else" })).toBe(null);
		});

		it("returns null for payloads without action field", () => {
			expect(classifyBrowserPayload({ name: "test" })).toBe(null);
		});

		it("returns null for empty payloads", () => {
			expect(classifyBrowserPayload({})).toBe(null);
		});
	});
});

describe("classifyBrowserCommandIdempotency", () => {
	describe("idempotent commands", () => {
		it("classifies browser:sync as idempotent", () => {
			expect(classifyBrowserCommandIdempotency("browser:sync")).toBe("idempotent");
		});

		it("classifies browser:observe as idempotent", () => {
			expect(classifyBrowserCommandIdempotency("browser:observe")).toBe("idempotent");
		});

		it("classifies browser:wait_for_selector as idempotent", () => {
			expect(classifyBrowserCommandIdempotency("browser:wait_for_selector")).toBe("idempotent");
		});

		it("classifies browser:get_text as idempotent", () => {
			expect(classifyBrowserCommandIdempotency("browser:get_text")).toBe("idempotent");
		});

		it("classifies browser:get_html as idempotent", () => {
			expect(classifyBrowserCommandIdempotency("browser:get_html")).toBe("idempotent");
		});

		it("classifies browser:get_attribute as idempotent", () => {
			expect(classifyBrowserCommandIdempotency("browser:get_attribute")).toBe("idempotent");
		});

		it("classifies browser:extract_readable as idempotent", () => {
			expect(classifyBrowserCommandIdempotency("browser:extract_readable")).toBe("idempotent");
		});

		it("classifies browser:screenshot as idempotent", () => {
			expect(classifyBrowserCommandIdempotency("browser:screenshot")).toBe("idempotent");
		});

		it("classifies tab:list as idempotent", () => {
			expect(classifyBrowserCommandIdempotency("tab:list")).toBe("idempotent");
		});
	});

	describe("mutating commands", () => {
		it("classifies browser:goto as mutating", () => {
			expect(classifyBrowserCommandIdempotency("browser:goto")).toBe("mutating");
		});

		it("classifies browser:force_reload as mutating", () => {
			expect(classifyBrowserCommandIdempotency("browser:force_reload")).toBe("mutating");
		});

		it("classifies browser:click as mutating", () => {
			expect(classifyBrowserCommandIdempotency("browser:click")).toBe("mutating");
		});

		it("classifies browser:type as mutating", () => {
			expect(classifyBrowserCommandIdempotency("browser:type")).toBe("mutating");
		});

		it("classifies browser:fill as mutating", () => {
			expect(classifyBrowserCommandIdempotency("browser:fill")).toBe("mutating");
		});

		it("classifies browser:press as mutating", () => {
			expect(classifyBrowserCommandIdempotency("browser:press")).toBe("mutating");
		});

		it("classifies browser:scroll as mutating", () => {
			expect(classifyBrowserCommandIdempotency("browser:scroll")).toBe("mutating");
		});

		it("classifies browser:drag as mutating", () => {
			expect(classifyBrowserCommandIdempotency("browser:drag")).toBe("mutating");
		});

		it("classifies browser:evaluate as mutating", () => {
			expect(classifyBrowserCommandIdempotency("browser:evaluate")).toBe("mutating");
		});

		it("classifies tab:open as mutating", () => {
			expect(classifyBrowserCommandIdempotency("tab:open")).toBe("mutating");
		});

		it("classifies tab:close as mutating", () => {
			expect(classifyBrowserCommandIdempotency("tab:close")).toBe("mutating");
		});

		it("classifies tab:switch as mutating", () => {
			expect(classifyBrowserCommandIdempotency("tab:switch")).toBe("mutating");
		});
	});
});

describe("classifyEvent with browser payloads", () => {
	describe("silent browser events", () => {
		it("integrates classifyBrowserPayload for browser:state", () => {
			expect(
				classifyEvent(
					mkEvent({
						name: "custom-event",
						payload: {
							action: "browser:state",
							state: "interactive",
							url: "https://example.com",
							title: "Example",
							statusText: "OK",
							lastError: "",
							canGoBack: false,
							canGoForward: false,
							loading: false,
						},
					}),
				),
			).toBe("silent");
		});

		it("integrates classifyBrowserPayload for browser:url_changed", () => {
			expect(
				classifyEvent(
					mkEvent({
						name: "custom-event",
						payload: {
							action: "browser:url_changed",
							url: "https://example.com/page",
							title: "Page",
						},
					}),
				),
			).toBe("silent");
		});

		it("integrates classifyBrowserPayload for non-error browser:console", () => {
			expect(
				classifyEvent(
					mkEvent({
						name: "custom-event",
						payload: {
							action: "browser:console",
							level: "log",
							message: "debug info",
							lineNumber: 42,
							sourceId: "script.js",
							silent: false,
						},
					}),
				),
			).toBe("silent");
		});
	});

	describe("loud browser events", () => {
		it("integrates classifyBrowserPayload for browser:result", () => {
			expect(
				classifyEvent(
					mkEvent({
						name: "custom-event",
						payload: {
							action: "browser:result",
							_rid: "req456",
							command: "browser:click",
							ok: true,
							result: null,
							error: null,
							url: "https://example.com",
							title: "Example",
							state: "interactive",
						},
					}),
				),
			).toBe("loud");
		});

		it("integrates classifyBrowserPayload for browser:navigation_failed", () => {
			expect(
				classifyEvent(
					mkEvent({
						name: "custom-event",
						payload: {
							action: "browser:navigation_failed",
							url: "https://unreachable.test",
							error: "connection timeout",
							errorCode: 6,
						},
					}),
				),
			).toBe("loud");
		});

		it("integrates classifyBrowserPayload for error browser:console", () => {
			expect(
				classifyEvent(
					mkEvent({
						name: "custom-event",
						payload: {
							action: "browser:console",
							level: "error",
							message: "fatal error",
							lineNumber: 200,
							sourceId: "error.js",
							silent: false,
						},
					}),
				),
			).toBe("loud");
		});

		it("classifies tab:result as loud", () => {
			expect(
				classifyEvent(
					mkEvent({
						name: "custom-event",
						payload: {
							action: "tab:result",
							_rid: "tab-1",
							command: "tab:open",
							ok: true,
							result: { activeTabId: "research-1" },
							error: null,
							activeTabId: "research-1",
						},
					}),
				),
			).toBe("loud");
		});
	});
});
