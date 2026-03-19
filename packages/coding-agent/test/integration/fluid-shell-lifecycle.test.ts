import { describe, expect, it } from "bun:test";
import { EventBus } from "../../src/utils/event-bus";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const FLUID_SHELL_QML = "FluidShell.qml";

describe.skipIf(!isBridgeAvailable())("FluidShell lifecycle", () => {
	it("launches in input state with visible window", async () => {
		const journey = await QmlJourney.launch(FLUID_SHELL_QML);
		try {
			await journey.settle(100);
			expect(await journey.evaluate<string>("root.state")).toBe("input");
			expect(await journey.evaluate<boolean>("root.visible")).toBe(true);
			expect(await journey.evaluate<boolean>("root.planReady")).toBe(false);
		} finally {
			await journey.teardown();
		}
	});

	it("teardown tolerates bridge outbound publish after disposal", async () => {
		const journey = await QmlJourney.launch(FLUID_SHELL_QML);
		const eventBus = new EventBus();
		const unsubscribe = eventBus.subscribe("bridge:outbound", (payload: unknown) => {
			void journey.agentSends(payload as Record<string, unknown>).catch(() => {
				// Bridge is expected to be disposed at this point.
			});
		});

		await journey.teardown();

		expect(() => {
			eventBus.emit("bridge:outbound", {
				type: "fluid:agent_stream",
				agentId: "agent-x",
				text: "post-dispose",
			});
		}).not.toThrow();

		unsubscribe();
	});
});
