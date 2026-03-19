import { FluidEventRouter } from "../../src/orchestrators/fluid";
import { EventBus } from "../../src/utils/event-bus";
import { QmlJourney } from "./qml-journey";

export interface FluidPipeline {
	eventBus: EventBus;
	router: FluidEventRouter;
	journey: QmlJourney;
	startDrain(): void;
	stopDrain(): Promise<void>;
	teardown(): Promise<void>;
}

export async function setupFluidPipeline(): Promise<FluidPipeline> {
	const eventBus = new EventBus();
	const router = new FluidEventRouter(eventBus);
	const journey = await QmlJourney.launch("FluidShell.qml");

	const bridgeUnsub = eventBus.subscribe("bridge:outbound", (raw: unknown) => {
		void journey.agentSends(raw as Record<string, unknown>).catch(() => {
			// Bridge may close during teardown; ignore late sends from queued events.
		});
	});

	let draining = false;
	let drainTimer: NodeJS.Timeout | undefined;
	let disposed = false;

	const drainEventBusOnce = async (): Promise<number> => {
		if (draining) {
			return 0;
		}
		draining = true;
		try {
			return await eventBus.drain();
		} finally {
			draining = false;
		}
	};

	const flushEventBus = async (): Promise<void> => {
		while (draining) {
			await Bun.sleep(5);
		}
		while ((await drainEventBusOnce()) > 0) {
			// EventBus.drain() is bounded per call; loop until the queue is empty.
		}
	};

	const startDrain = (): void => {
		if (drainTimer) {
			return;
		}
		drainTimer = setInterval(() => {
			void drainEventBusOnce();
		}, 100);
	};

	const stopDrain = async (): Promise<void> => {
		if (drainTimer) {
			clearInterval(drainTimer);
			drainTimer = undefined;
		}
		await flushEventBus();
	};

	const teardown = async (): Promise<void> => {
		if (disposed) {
			return;
		}
		disposed = true;
		// Match production cleanup ordering: stop drain -> dispose router -> unsubscribe bridge -> teardown bridge.
		await stopDrain();
		router.dispose();
		bridgeUnsub();
		await journey.teardown();
	};

	return {
		eventBus,
		router,
		journey,
		startDrain,
		stopDrain,
		teardown,
	};
}
