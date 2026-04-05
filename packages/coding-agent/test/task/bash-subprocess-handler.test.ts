import { describe, expect, it } from "bun:test";
import type { SubprocessToolEvent } from "../../src/task/subprocess-tool-registry";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";
// Side-effect import to register the handler
import "../../src/task/bash-subprocess-handler";

describe("bash-subprocess-handler", () => {
	it("registers the bash handler", () => {
		expect(subprocessToolRegistry.hasHandler("bash")).toBe(true);

		const handler = subprocessToolRegistry.getHandler("bash");
		expect(handler).toBeDefined();
		expect(handler?.extractData).toBeDefined();
		expect(handler?.shouldTerminate).toBeUndefined();
	});

	it("extracts command and exit code for successful bash execution", () => {
		const event: SubprocessToolEvent = {
			toolName: "bash",
			toolCallId: "call-1",
			args: { command: "bun test" },
			isError: false,
		};

		const handler = subprocessToolRegistry.getHandler("bash");
		expect(handler?.extractData?.(event)).toEqual({ command: "bun test", exitCode: 0 });
	});

	it("extracts command and exit code for failed bash execution", () => {
		const event: SubprocessToolEvent = {
			toolName: "bash",
			toolCallId: "call-1",
			args: { command: "bun test" },
			isError: true,
		};

		const handler = subprocessToolRegistry.getHandler("bash");
		expect(handler?.extractData?.(event)).toEqual({ command: "bun test", exitCode: 1 });
	});

	it("returns undefined when command is missing", () => {
		const event: SubprocessToolEvent = {
			toolName: "bash",
			toolCallId: "call-1",
			args: {},
		};

		const handler = subprocessToolRegistry.getHandler("bash");
		expect(handler?.extractData?.(event)).toBeUndefined();
	});

	it("returns undefined when command is not a string", () => {
		const event: SubprocessToolEvent = {
			toolName: "bash",
			toolCallId: "call-1",
			args: { command: 123 },
		};

		const handler = subprocessToolRegistry.getHandler("bash");
		expect(handler?.extractData?.(event)).toBeUndefined();
	});

	it("returns undefined when command is empty", () => {
		const event: SubprocessToolEvent = {
			toolName: "bash",
			toolCallId: "call-1",
			args: { command: "" },
		};

		const handler = subprocessToolRegistry.getHandler("bash");
		expect(handler?.extractData?.(event)).toBeUndefined();
	});

	it("returns undefined when args are absent", () => {
		const event: SubprocessToolEvent = {
			toolName: "bash",
			toolCallId: "call-1",
		};

		const handler = subprocessToolRegistry.getHandler("bash");
		expect(handler?.extractData?.(event)).toBeUndefined();
	});
});
