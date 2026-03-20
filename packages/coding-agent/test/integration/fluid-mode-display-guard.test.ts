import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runFluidMode } from "../../src/modes/fluid-mode";
import type { AgentSession } from "../../src/session/agent-session";
import { EventBus } from "../../src/utils/event-bus";

const originalDisplay = process.env.DISPLAY;
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY;

describe.skipIf(process.platform !== "linux")("runFluidMode display guard", () => {
	beforeEach(() => {
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
	});

	afterEach(() => {
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		if (originalWaylandDisplay === undefined) {
			delete process.env.WAYLAND_DISPLAY;
		} else {
			process.env.WAYLAND_DISPLAY = originalWaylandDisplay;
		}
	});

	test("fails fast with a clear error when no graphical display is available", async () => {
		const eventBus = new EventBus();
		await expect(runFluidMode({} as AgentSession, { eventBus })).rejects.toThrow(
			"Fluid mode requires a graphical display (DISPLAY or WAYLAND_DISPLAY must be set)",
		);
	});
});
