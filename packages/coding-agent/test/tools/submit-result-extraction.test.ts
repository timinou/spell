import { describe, expect, it } from "bun:test";
import "../../src/tools/submit-result";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";

describe("submit_result subprocess extraction", () => {
	const handler = subprocessToolRegistry.getHandler("submit_result");

	it("extracts valid submit_result payloads", () => {
		expect(handler?.extractData).toBeDefined();
		const data = handler?.extractData?.({
			toolName: "submit_result",
			toolCallId: "call-1",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		});
		expect(data).toEqual({ status: "success", data: { ok: true }, error: undefined, keepGoing: false });
	});

	it("extracts keepGoing:true for checkpoint submissions (PLAN-350)", () => {
		const data = handler?.extractData?.({
			toolName: "submit_result",
			toolCallId: "call-checkpoint",
			result: {
				content: [{ type: "text", text: "Checkpoint recorded." }],
				details: { status: "success", data: { progress: "halfway" }, keepGoing: true },
			},
			isError: false,
		});
		expect(data).toEqual({
			status: "success",
			data: { progress: "halfway" },
			error: undefined,
			keepGoing: true,
		});
	});

	it("shouldTerminate is false for a keepGoing:true checkpoint, true for a resolved terminal", () => {
		const checkpointTerminate = handler?.shouldTerminate?.({
			toolName: "submit_result",
			toolCallId: "call-checkpoint",
			result: {
				content: [{ type: "text", text: "Checkpoint recorded." }],
				details: { status: "success", data: { progress: "halfway" }, keepGoing: true },
			},
			isError: false,
		});
		expect(checkpointTerminate).toBe(false);

		const terminalTerminate = handler?.shouldTerminate?.({
			toolName: "submit_result",
			toolCallId: "call-terminal",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true }, keepGoing: false },
			},
			isError: false,
		});
		expect(terminalTerminate).toBe(true);
	});

	it("ignores malformed submit_result details without status", () => {
		const data = handler?.extractData?.({
			toolName: "submit_result",
			toolCallId: "call-2",
			result: {
				content: [{ type: "text", text: "Tool execution was aborted." }],
				details: {},
			},
			isError: true,
		});
		expect(data).toBeUndefined();
	});
});
