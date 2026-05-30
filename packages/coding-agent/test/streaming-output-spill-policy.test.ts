import { describe, expect, it } from "bun:test";
import { OutputSink } from "@spell/pi-coding-agent/session/streaming-output";

describe("OutputSink spill policy", () => {
	it("spills once the line threshold is exceeded", async () => {
		const sink = new OutputSink({
			spillThresholdBytes: 10_000,
			spillThresholdLines: 3,
			retainMaxBytes: 10_000,
			retainMaxLines: 10,
		});

		await sink.push("line1\nline2\nline3\nline4");
		const summary = await sink.dump();

		expect(summary.truncated).toBe(true);
		expect(summary.totalLines).toBe(4);
		expect(summary.output).toContain("line4");
	});

	it("applies smaller success and larger failure dump budgets truthfully", async () => {
		const makeSink = () =>
			new OutputSink({
				spillThresholdBytes: 5,
				spillThresholdLines: 2,
				retainMaxBytes: 10_000,
				retainMaxLines: 120,
			});

		const successSink = makeSink();
		await successSink.push(Array.from({ length: 80 }, (_, index) => `line${index + 1}`).join("\n"));
		const success = await successSink.dump({ maxBytes: 1024, maxLines: 50 });
		expect(success.output).toContain("line80");
		expect(success.output).toContain("line31");
		expect(success.output).not.toContain("line30");

		const failureSink = makeSink();
		await failureSink.push(Array.from({ length: 140 }, (_, index) => `line${index + 1}`).join("\n"));
		const failure = await failureSink.dump({ maxBytes: 5 * 1024, maxLines: 120 });
		expect(failure.output).toContain("line140");
		expect(failure.output).toContain("line21");
		expect(failure.output).not.toContain("line20");
	});
});
