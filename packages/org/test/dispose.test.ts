/**
 * Tests for org tool dispose behavior.
 *
 * Contracts:
 * 1. dispose() before first use (no session started) does not throw.
 * 2. dispose() with rejected factory handles gracefully.
 * 3. dispose() is idempotent — second call is a no-op.
 */

import { describe, expect, it, mock } from "bun:test";
import type { EmacsSession } from "@oh-my-pi/pi-emacs";
import { DEFAULT_ORG_CONFIG } from "../src/schema/defaults";
import { createOrgTool } from "../src/tool";

function mockSession(overrides: Partial<EmacsSession> = {}): EmacsSession {
	return {
		socketPath: "/tmp/test-org.sock",
		stop: mock(async () => {}),
		isAlive: () => true,
		...overrides,
	};
}

describe("org tool dispose", () => {
	it("dispose before first use does not throw", async () => {
		const session = mockSession();
		const factory = mock(async () => session);
		const tool = createOrgTool("/tmp/project", DEFAULT_ORG_CONFIG, factory);

		expect(tool.dispose).toBeDefined();
		// No execute calls — session was never started.
		await tool.dispose!();
		expect(factory).not.toHaveBeenCalled();
	});

	it("dispose with rejected factory does not throw", async () => {
		const factory = mock(async (): Promise<EmacsSession> => {
			throw new Error("Emacs not found");
		});
		const tool = createOrgTool("/tmp/project", DEFAULT_ORG_CONFIG, factory);

		// Factory was never triggered via execute, so dispose is a no-op.
		await tool.dispose!();
	});

	it("dispose is idempotent", async () => {
		const session = mockSession();
		const factory = mock(async () => session);
		const tool = createOrgTool("/tmp/project", DEFAULT_ORG_CONFIG, factory);

		// Two consecutive dispose calls should both succeed.
		await tool.dispose!();
		await tool.dispose!();
	});
});
