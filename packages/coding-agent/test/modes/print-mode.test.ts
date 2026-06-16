import { describe, expect, it } from "bun:test";
import { getPrintModeFailureMessage, runPrintMode } from "../../src/modes/print-mode";

describe("getPrintModeFailureMessage", () => {
	it("returns undefined for successful assistant messages", () => {
		expect(
			getPrintModeFailureMessage([
				{ role: "user" },
				{ role: "assistant", stopReason: "stop", errorMessage: "ignored" },
			]),
		).toBeUndefined();
	});

	it("surfaces assistant error messages so JSON print mode can exit non-zero", () => {
		expect(
			getPrintModeFailureMessage([
				{ role: "user" },
				{ role: "assistant", stopReason: "error", errorMessage: "Unable to connect" },
			]),
		).toBe("Unable to connect");
	});

	it("falls back to the stop reason when providers omit an error message", () => {
		expect(getPrintModeFailureMessage([{ role: "assistant", stopReason: "aborted" }])).toBe("Request aborted");
	});

	it("returns a non-zero exit code for JSON mode assistant failures", async () => {
		let disposed = false;
		const session = {
			sessionManager: {
				getHeader: () => undefined,
			},
			extensionRunner: undefined,
			subscribe: () => undefined,
			state: {
				messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider failed" }],
			},
			dispose: async () => {
				disposed = true;
			},
		};

		const exitCode = await runPrintMode(session as never, { mode: "json" });

		expect(exitCode).toBe(1);
		expect(disposed).toBe(true);
	});
});
