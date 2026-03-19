import { describe, expect, test } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs --canvas", () => {
	test("defaults to fluid when --canvas has no value", () => {
		const result = parseArgs(["--canvas"]);
		expect(result.canvas).toBe("fluid");
	});

	test("parses --canvas chat", () => {
		const result = parseArgs(["--canvas", "chat"]);
		expect(result.canvas).toBe("chat");
	});

	test("parses --canvas fluid", () => {
		const result = parseArgs(["--canvas", "fluid"]);
		expect(result.canvas).toBe("fluid");
	});

	test("uses fluid when next arg is another flag", () => {
		const result = parseArgs(["--canvas", "--print"]);
		expect(result.canvas).toBe("fluid");
		expect(result.print).toBe(true);
	});

	test("does not validate unknown canvas mode at parse time", () => {
		const result = parseArgs(["--canvas", "unknown"]);
		expect(result.canvas).toBe("unknown");
	});

	test("leaves canvas undefined when flag is absent", () => {
		const result = parseArgs([]);
		expect(result.canvas).toBeUndefined();
	});
});
