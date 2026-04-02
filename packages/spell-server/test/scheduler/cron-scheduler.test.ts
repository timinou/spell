import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { type GoalScheduleEntry, GoalScheduler } from "../../src/scheduler";

function createEntry(overrides: Partial<GoalScheduleEntry> = {}): GoalScheduleEntry {
	return {
		goalName: "nightly-tests",
		cronExpression: "*/5 * * * * *",
		jitterMs: 0,
		callback: vi.fn(),
		...overrides,
	};
}

function msUntilNextSecond(): number {
	return 1_000 - (Date.now() % 1_000);
}

describe("GoalScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("registers a cron goal and reports a future fire time", () => {
		const scheduler = new GoalScheduler();
		scheduler.register(createEntry());

		const nextRun = scheduler.getNextFireTime("nightly-tests");
		expect(nextRun).toBeInstanceOf(Date);
		expect(nextRun!.getTime()).toBeGreaterThan(Date.now());
	});

	it("throws when registering an invalid cron expression", () => {
		const scheduler = new GoalScheduler();
		expect(() => scheduler.register(createEntry({ cronExpression: "not a cron" }))).toThrow();
	});

	it("unregister removes the goal and its next fire time", () => {
		const scheduler = new GoalScheduler();
		scheduler.register(createEntry());

		scheduler.unregister("nightly-tests");

		expect(scheduler.getNextFireTime("nightly-tests")).toBeNull();
		expect(scheduler.getScheduledGoals()).toEqual([]);
	});

	it("re-registering replaces the existing schedule", () => {
		const scheduler = new GoalScheduler();
		scheduler.register(createEntry({ cronExpression: "*/5 * * * * *" }));
		scheduler.register(createEntry({ cronExpression: "*/10 * * * * *" }));

		expect(scheduler.getScheduledGoals()).toHaveLength(1);
		expect(scheduler.getScheduledGoals()[0]?.cronExpression).toBe("*/10 * * * * *");
		expect(scheduler.getScheduledGoals()[0]?.goalName).toBe("nightly-tests");
	});

	it("lists all registered goals independently", () => {
		const scheduler = new GoalScheduler();
		scheduler.register(createEntry());
		scheduler.register(
			createEntry({ goalName: "cleanup", cronExpression: "*/15 * * * * *", timezone: "UTC", jitterMs: 250 }),
		);

		expect(scheduler.getScheduledGoals()).toEqual([
			expect.objectContaining({ goalName: "nightly-tests", cronExpression: "*/5 * * * * *", jitterMs: 0 }),
			expect.objectContaining({
				goalName: "cleanup",
				cronExpression: "*/15 * * * * *",
				timezone: "UTC",
				jitterMs: 250,
			}),
		]);
	});

	it("start and stop control callback execution", () => {
		const callback = vi.fn();
		const scheduler = new GoalScheduler();
		scheduler.register(createEntry({ callback }));

		vi.advanceTimersByTime(2_100);
		expect(callback).not.toHaveBeenCalled();

		scheduler.start();
		vi.advanceTimersByTime(5_000);
		expect(callback).toHaveBeenCalled();
		const callCountAfterStart = callback.mock.calls.length;

		scheduler.stop();
		vi.advanceTimersByTime(5_000);
		expect(callback).toHaveBeenCalledTimes(callCountAfterStart);
	});

	it("uses jitter before firing the callback", async () => {
		vi.useRealTimers();
		const callback = vi.fn();
		const scheduler = new GoalScheduler();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		scheduler.register(createEntry({ callback, jitterMs: 1_000, cronExpression: "* * * * * *" }));
		scheduler.start();

		await Bun.sleep(msUntilNextSecond() + 100);
		expect(callback).not.toHaveBeenCalled();

		await Bun.sleep(500);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("stopping clears pending jitter timers", async () => {
		vi.useRealTimers();
		const callback = vi.fn();
		const scheduler = new GoalScheduler();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		scheduler.register(createEntry({ callback, jitterMs: 1_000, cronExpression: "* * * * * *" }));
		scheduler.start();

		await Bun.sleep(msUntilNextSecond() + 100);
		scheduler.stop();
		await Bun.sleep(1_100);

		expect(callback).not.toHaveBeenCalled();
	});

	it("skips overlapping ticks while an async callback is still running", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const deferred = Promise.withResolvers<void>();
		const callback = vi.fn(() => deferred.promise);
		const scheduler = new GoalScheduler();
		scheduler.register(createEntry({ callback, cronExpression: "* * * * * *" }));
		scheduler.start();

		vi.advanceTimersByTime(1_000);
		await Promise.resolve();
		expect(callback).toHaveBeenCalledTimes(1);
		expect(scheduler.getScheduledGoals()[0]?.running).toBe(true);

		vi.advanceTimersByTime(1_000);
		await Promise.resolve();
		expect(callback).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith("Skipping cron tick: goal already running", { goalName: "nightly-tests" });

		deferred.resolve();
		await deferred.promise;
		await Promise.resolve();
		expect(scheduler.getScheduledGoals()[0]?.running).toBe(false);
	});

	it("markRunComplete resets the running flag", async () => {
		const deferred = Promise.withResolvers<void>();
		const scheduler = new GoalScheduler();
		scheduler.register(createEntry({ callback: () => deferred.promise, cronExpression: "* * * * * *" }));
		scheduler.start();

		vi.advanceTimersByTime(1_000);
		await Promise.resolve();
		expect(scheduler.getScheduledGoals()[0]?.running).toBe(true);

		scheduler.markRunComplete("nightly-tests");
		expect(scheduler.getScheduledGoals()[0]?.running).toBe(false);

		deferred.resolve();
		await deferred.promise;
	});

	it("handles multiple goals without cross-talk", () => {
		const nightlyCallback = vi.fn();
		const cleanupCallback = vi.fn();
		const scheduler = new GoalScheduler();
		scheduler.register(createEntry({ callback: nightlyCallback, cronExpression: "*/2 * * * * *" }));
		scheduler.register(
			createEntry({ goalName: "cleanup", callback: cleanupCallback, cronExpression: "*/3 * * * * *" }),
		);
		scheduler.start();

		vi.advanceTimersByTime(6_100);
		expect(nightlyCallback.mock.calls.length).toBeGreaterThan(0);
		expect(cleanupCallback.mock.calls.length).toBeGreaterThan(0);
		expect(nightlyCallback.mock.calls.length).not.toBe(cleanupCallback.mock.calls.length);
	});

	it("does not crash when started and stopped without jobs", () => {
		const scheduler = new GoalScheduler();
		expect(() => {
			scheduler.start();
			scheduler.stop();
		}).not.toThrow();
		expect(scheduler.getScheduledGoals()).toEqual([]);
	});
});
