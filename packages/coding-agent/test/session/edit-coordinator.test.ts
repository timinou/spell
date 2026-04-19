import { describe, expect, it, spyOn } from "bun:test";
import { callCodeBuffer, coordStatus, isMutatingCommand } from "@oh-my-pi/pi-coding-agent/session/edit-coordinator";
import * as nativesModule from "@oh-my-pi/pi-natives";

describe("edit coordinator", () => {
	it("injects parent sessionId for mutating calls", () => {
		const executeSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { success: true },
			error: false,
		});
		callCodeBuffer({ session: { getSessionId: () => "parent-123" } }, { command: "save", file: "/tmp/example.ts" });
		expect(executeSpy).toHaveBeenCalledWith({ command: "save", file: "/tmp/example.ts", sessionId: "parent-123" });
		executeSpy.mockRestore();
	});

	it("injects subagent sessionId when available", () => {
		const executeSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { success: true },
			error: false,
		});
		callCodeBuffer(
			{ session: { getSessionId: () => "sub-456" } },
			{ command: "replace_content", file: "/tmp/example.ts", content: "x" },
		);
		expect(executeSpy).toHaveBeenCalledWith({
			command: "replace_content",
			file: "/tmp/example.ts",
			content: "x",
			sessionId: "sub-456",
		});
		executeSpy.mockRestore();
	});

	it("omits sessionId when no session is available", () => {
		const executeSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { success: true },
			error: false,
		});
		callCodeBuffer({ session: {} }, { command: "replace_content", file: "/tmp/example.ts", content: "x" });
		expect(executeSpy).toHaveBeenCalledWith({ command: "replace_content", file: "/tmp/example.ts", content: "x" });
		executeSpy.mockRestore();
	});

	it("leaves read-only calls uncoordinated", () => {
		const executeSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { lines: [] },
			error: false,
		});
		callCodeBuffer({ session: {} }, { command: "outline", file: "/tmp/example.ts" });
		expect(executeSpy).toHaveBeenCalledWith({ command: "outline", file: "/tmp/example.ts" });
		executeSpy.mockRestore();
	});

	it("returns coord status summaries", () => {
		const executeSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { brokerUp: true, peers: [{ sessionId: "peer-b" }], socketPath: "/tmp/edit-broker.sock" },
			error: false,
		});
		expect(coordStatus("/tmp/example.ts")).toEqual({
			brokerUp: true,
			peers: [{ sessionId: "peer-b" }],
			socketPath: "/tmp/edit-broker.sock",
		});
		expect(executeSpy).toHaveBeenCalledWith({ command: "coord_status", file: "/tmp/example.ts" });
		expect(isMutatingCommand("edit")).toBe(true);
		expect(isMutatingCommand("outline")).toBe(false);
		executeSpy.mockRestore();
	});
});
