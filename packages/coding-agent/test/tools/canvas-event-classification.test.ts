import { describe, expect, it } from "bun:test";
import { classifyEvent } from "../../src/tools/canvas-event-utils";

type CanvasEvent = Parameters<typeof classifyEvent>[0];

function mkEvent(overrides: Partial<CanvasEvent> = {}): CanvasEvent {
	return { name: "", payload: {}, ...overrides };
}

describe("classifyEvent", () => {
	describe("loud events", () => {
		it("classifies 'close' event name as loud", () => {
			expect(classifyEvent(mkEvent({ name: "close" }))).toBe("loud");
		});

		it("classifies payload.action === 'close' as loud regardless of name", () => {
			expect(classifyEvent(mkEvent({ name: "something_else", payload: { action: "close" } }))).toBe("loud");
		});

		it("classifies unknown event types as loud (fail-open)", () => {
			expect(classifyEvent(mkEvent({ name: "user_clicked" }))).toBe("loud");
		});

		it("classifies event with no name and no special payload as loud", () => {
			expect(classifyEvent(mkEvent())).toBe("loud");
		});
	});

	describe("silent events", () => {
		it("classifies 'url_changed' as silent", () => {
			expect(classifyEvent(mkEvent({ name: "url_changed" }))).toBe("silent");
		});

		it("classifies payload.silent === true as silent", () => {
			expect(classifyEvent(mkEvent({ name: "anything", payload: { silent: true } }))).toBe("silent");
		});
	});

	describe("stderr classification", () => {
		it("classifies stderr with TypeError as loud", () => {
			expect(
				classifyEvent(mkEvent({ name: "stderr", payload: { text: "Uncaught TypeError: x is not a function" } })),
			).toBe("loud");
		});

		it("classifies stderr with SyntaxError as loud", () => {
			expect(classifyEvent(mkEvent({ name: "stderr", payload: { text: "SyntaxError: unexpected token" } }))).toBe(
				"loud",
			);
		});

		it("classifies stderr with ReferenceError as loud", () => {
			expect(
				classifyEvent(mkEvent({ name: "stderr", payload: { text: "ReferenceError: foo is not defined" } })),
			).toBe("loud");
		});

		it("classifies stderr with fontconfig warning as silent", () => {
			expect(classifyEvent(mkEvent({ name: "stderr", payload: { text: "Fontconfig warning: no such file" } }))).toBe(
				"silent",
			);
		});

		it("classifies stderr with CSP frame-ancestors as silent", () => {
			expect(
				classifyEvent(
					mkEvent({ name: "stderr", payload: { text: "Refused to frame because of frame-ancestors" } }),
				),
			).toBe("silent");
		});

		it("classifies stderr with both fontconfig AND TypeError as loud (error takes precedence)", () => {
			expect(
				classifyEvent(
					mkEvent({
						name: "stderr",
						payload: { text: "fontconfig warning blah TypeError: undefined is not an object" },
					}),
				),
			).toBe("loud");
		});

		it("reads text from payload.message when payload.text is absent", () => {
			expect(classifyEvent(mkEvent({ name: "stderr", payload: { message: "TypeError: bang" } }))).toBe("loud");
		});

		it("reads text from payload.data when text and message are absent", () => {
			expect(classifyEvent(mkEvent({ name: "stderr", payload: { data: "fontconfig issue" } }))).toBe("silent");
		});

		it("classifies unknown stderr content as loud", () => {
			expect(classifyEvent(mkEvent({ name: "stderr", payload: { text: "some random warning" } }))).toBe("loud");
		});
	});

	describe("precedence", () => {
		it("payload.silent takes precedence over close name", () => {
			// silent check runs before close check
			expect(classifyEvent(mkEvent({ name: "close", payload: { silent: true } }))).toBe("silent");
		});
	});
});
