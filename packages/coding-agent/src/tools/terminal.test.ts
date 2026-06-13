import { describe, expect, it } from "bun:test";
import type { ToolSession } from "./index";
import { TerminalTool } from "./terminal";

const session = { cwd: "/tmp" } as unknown as ToolSession;

describe("TerminalTool", () => {
	it("errors clearly when there is no UI (a pty needs a real TTY)", async () => {
		const tool = new TerminalTool(session);
		// No ctx.ui → cannot attach a pty.
		await expect(
			tool.execute("c1", { command: "htop" }, undefined, undefined, { hasUI: false } as never),
		).rejects.toThrow(/requires an interactive UI/);
	});

	it("errors when ctx is absent entirely", async () => {
		const tool = new TerminalTool(session);
		await expect(tool.execute("c1", { command: "vim" }, undefined, undefined, undefined)).rejects.toThrow(
			/requires an interactive UI/,
		);
	});

	it("advertises itself as the interactive escape hatch, not a scripting tool", () => {
		const tool = new TerminalTool(session);
		expect(tool.name).toBe("terminal");
		expect(tool.description).toContain("INTERACTIVE");
		expect(tool.description.toLowerCase()).toContain("prefer run/git/execute");
	});
});
