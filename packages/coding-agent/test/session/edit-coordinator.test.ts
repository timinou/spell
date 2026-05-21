import { describe, expect, it, spyOn } from "bun:test";
import { coordStatus } from "@oh-my-pi/pi-coding-agent/session/edit-coordinator";
import * as nativesModule from "@oh-my-pi/pi-natives";

describe("edit coordinator", () => {
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
		executeSpy.mockRestore();
	});
});
