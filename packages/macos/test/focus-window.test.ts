import { describe, expect, it } from "bun:test";
import { focusTerminalByPid } from "../src/focus-window";

describe("focusTerminalByPid", () => {
	it("returns false on non-macOS platforms", async () => {
		if (process.platform === "darwin") return;
		await expect(focusTerminalByPid(process.pid)).resolves.toBe(false);
	});
});
