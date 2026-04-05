import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getReportsDir, postmortem } from "@oh-my-pi/pi-utils";

describe("writeCrashReport", () => {
	it("accepts SIGHUP reason and writes a valid crash report", () => {
		const reportPath = postmortem.writeCrashReport(postmortem.Reason.SIGHUP, new Error("Process received SIGHUP"));

		expect(reportPath).toBeDefined();
		expect(reportPath).toContain("crash-");
		expect(reportPath).toEndWith(".json");

		const content = fs.readFileSync(reportPath!, "utf8");
		const report = JSON.parse(content);

		expect(report.reason).toBe("sighup");
		expect(report.error.name).toBe("Error");
		expect(report.error.message).toBe("Process received SIGHUP");
		expect(report.error.stack).toBeDefined();
		expect(report.pid).toBe(process.pid);
		expect(report.system).toBeDefined();
		expect(report.system.versions.app).toBeDefined();

		fs.unlinkSync(reportPath!);
	});

	it("accepts SIGTERM reason", () => {
		const reportPath = postmortem.writeCrashReport(postmortem.Reason.SIGTERM, new Error("Process received SIGTERM"));

		expect(reportPath).toBeDefined();
		const content = fs.readFileSync(reportPath!, "utf8");
		const report = JSON.parse(content);
		expect(report.reason).toBe("sigterm");
		expect(report.error.message).toBe("Process received SIGTERM");

		fs.unlinkSync(reportPath!);
	});

	it("accepts SIGINT reason", () => {
		const reportPath = postmortem.writeCrashReport(postmortem.Reason.SIGINT, new Error("Process received SIGINT"));

		expect(reportPath).toBeDefined();
		const content = fs.readFileSync(reportPath!, "utf8");
		const report = JSON.parse(content);
		expect(report.reason).toBe("sigint");
		expect(report.error.message).toBe("Process received SIGINT");

		fs.unlinkSync(reportPath!);
	});

	it("writes crash report to the reports directory", () => {
		const reportPath = postmortem.writeCrashReport(postmortem.Reason.SIGHUP, new Error("test"));

		expect(reportPath).toBeDefined();
		const reportsDir = getReportsDir();
		expect(reportPath).toStartWith(reportsDir);
		expect(path.basename(reportPath!)).toStartWith("crash-");

		fs.unlinkSync(reportPath!);
	});
});
