import { describe, expect, test } from "bun:test";
import { parseArgs } from "@spell/pi-coding-agent/cli/args";

describe("parseArgs --canvas", () => {
	test("defaults to empty (growth QML shell) when --canvas has no value", () => {
		const result = parseArgs(["--canvas"]);
		expect(result.canvas).toBe("");
	});

	test("parses --canvas chat", () => {
		const result = parseArgs(["--canvas", "chat"]);
		expect(result.canvas).toBe("chat");
	});

	test("parses --canvas browse", () => {
		const result = parseArgs(["--canvas", "browse"]);
		expect(result.canvas).toBe("browse");
	});

	test("uses empty canvas when next arg is another flag", () => {
		const result = parseArgs(["--canvas", "--print"]);
		expect(result.canvas).toBe("");
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
