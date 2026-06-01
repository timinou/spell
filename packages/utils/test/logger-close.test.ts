import { describe, expect, it } from "bun:test";
import { logger } from "@spell/pi-utils";

describe("logger.close", () => {
	it("resolves without error and is idempotent", async () => {
		// logger.close() calls winstonLogger.end() and waits for 'finish' event.
		// After this call the logger is unusable, but since this is a test and
		// each test file runs in its own worker, this is safe.
		await expect(logger.close()).resolves.toBeUndefined();

		// Second call should also resolve cleanly (idempotent — returns immediately)
		await expect(logger.close()).resolves.toBeUndefined();
	});
});
