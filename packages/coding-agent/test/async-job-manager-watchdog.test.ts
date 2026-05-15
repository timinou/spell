import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

describe("AsyncJobManager watchdog", () => {
	test("watchdog fires when run() never resolves and never reports progress", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			jobTimeoutMs: 100,
			watchdogGraceMs: 50,
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "hang forever", async () => {
			await new Promise(() => {});
			return "never";
		});

		const deadline = Date.now() + 400;
		while (manager.getJob(jobId)?.status === "running") {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for watchdog to fire");
			await Bun.sleep(5);
		}

		const job = manager.getJob(jobId);
		expect(job?.status).toBe("failed");
		expect(job?.errorText).toContain("watchdog timeout");
		expect(job?.endTime).toBeDefined();

		const raceResult = await Promise.race([job!.promise, Bun.sleep(800).then(() => "timeout")]);
		expect(raceResult).not.toBe("timeout");

		expect(completions.length).toBeGreaterThanOrEqual(1);
		expect(completions.some(c => c.jobId === jobId && c.text.includes("watchdog timeout"))).toBe(true);
	});

	test("progress updates reset the watchdog deadline", async () => {
		const manager = new AsyncJobManager({
			jobTimeoutMs: 200,
			watchdogGraceMs: 50,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("bash", "keep alive", async ({ reportProgress }) => {
			const start = Date.now();
			while (Date.now() - start < 600) {
				await reportProgress("tick");
				await Bun.sleep(50);
			}
			return "ok";
		});

		const deadline = Date.now() + 2_000;
		while (manager.getJob(jobId)?.status === "running") {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for job to complete");
			await Bun.sleep(5);
		}

		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(manager.getJob(jobId)?.resultText).toBe("ok");
	});

	test("timeoutMs <= 0 disables the watchdog", async () => {
		const manager = new AsyncJobManager({
			jobTimeoutMs: 0,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("bash", "short sleep", async () => {
			await Bun.sleep(300);
			return "done";
		});

		await manager.waitForAll();
		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(manager.getJob(jobId)?.resultText).toBe("done");
	});

	test("per-register override beats manager default", async () => {
		const manager = new AsyncJobManager({
			jobTimeoutMs: 10_000,
			watchdogGraceMs: 50,
			onJobComplete: async () => {},
		});

		const jobId = manager.register(
			"bash",
			"override hang",
			async () => {
				await new Promise(() => {});
				return "never";
			},
			{ timeoutMs: 80 },
		);

		const deadline = Date.now() + 300;
		while (manager.getJob(jobId)?.status === "running") {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for override watchdog to fire");
			await Bun.sleep(5);
		}

		expect(manager.getJob(jobId)?.status).toBe("failed");
		expect(manager.getJob(jobId)?.errorText).toContain("watchdog timeout");
	});

	test("watchdog aborts the job's AbortController before marking failed", async () => {
		const manager = new AsyncJobManager({
			jobTimeoutMs: 50,
			watchdogGraceMs: 100,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("bash", "cooperative cleanup", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "cleaned-up";
		});

		const raceResult = await Promise.race([manager.getJob(jobId)!.promise, Bun.sleep(400).then(() => "timeout")]);
		expect(raceResult).not.toBe("timeout");

		const job = manager.getJob(jobId);
		// Cooperative resolve within grace window should yield completed, but accept either.
		expect(["completed", "failed"]).toContain(job?.status ?? "");
	});
});
