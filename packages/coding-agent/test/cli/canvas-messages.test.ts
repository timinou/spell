import { describe, expect, test } from "bun:test";
import { CANVAS_DISPLAY_REQUIRED_MESSAGE, formatUnknownCanvasMessage } from "@oh-my-pi/pi-coding-agent/main";

describe("canvas CLI messages", () => {
	test("display guard message explains required environment variables", () => {
		expect(CANVAS_DISPLAY_REQUIRED_MESSAGE).toBe(
			"--canvas requires a graphical display (DISPLAY or WAYLAND_DISPLAY must be set)",
		);
	});

	test("unknown canvas message includes supported modes and usage syntax", () => {
		const message = formatUnknownCanvasMessage("custom");
		expect(message).toContain("Unknown canvas: custom.");
		expect(message).toContain("Available: chat, fluid.");
		expect(message).toContain("Use: spell --canvas [fluid|chat] [options] [message]");
	});
});
