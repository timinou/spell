import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ExitPlanModeTool } from "@oh-my-pi/pi-coding-agent/tools/exit-plan-mode";

describe("ExitPlanModeTool validation", () => {
	let tmpDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exit-plan-validation-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
		await Bun.write(path.join(artifactsDir, "local", "PLAN.md"), "# Plan\n");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function createSession(): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "session-v",
			getPlanModeState: () => ({ type: "plan" as const, enabled: true, planFilePath: "local://PLAN.md" }),
		};
	}

	async function writeOrgItem(
		category: "plans" | "features" | "bugs",
		id: string,
		body: string,
		props?: { effort?: string; priority?: string; layer?: string },
	): Promise<void> {
		const categoryDir = path.join(tmpDir, "!tasks", category);
		await fs.mkdir(categoryDir, { recursive: true });
		const lines = [`#+TITLE: ${id}`, `#+CUSTOM_ID: ${id}`, "#+STATE: ITEM"];
		if (props?.effort !== undefined) lines.push(`#+EFFORT: ${props.effort}`);
		else lines.push("#+EFFORT: 1h");
		if (props?.priority !== undefined) lines.push(`#+PRIORITY: ${props.priority}`);
		else lines.push("#+PRIORITY: #A");
		if (props?.layer !== undefined) lines.push(`#+LAYER: ${props.layer}`);
		else lines.push("#+LAYER: backend");
		lines.push("", body, "");
		await Bun.write(path.join(categoryDir, `${id}.org`), lines.join("\n"));
	}

	const VALID_BODY = [
		"* Scope",
		"Implement the authentication API with JWT tokens and session management.",
		"",
		"* Implementation",
		"Modify src/auth.ts to add the login endpoint. Use existing middleware patterns from src/middleware/auth.ts.",
		"",
		"* Acceptance Criteria",
		"- POST /api/auth/login returns a valid JWT on correct credentials",
		"- Invalid credentials return 401 with error message",
	].join("\n");

	it("rejects child items with empty body", async () => {
		await writeOrgItem("features", "FEAT-100-empty", "");
		await writeOrgItem(
			"plans",
			"PLAN-100-test",
			"* Context\nTest\n\n* Execution Manifest\n- [[id:FEAT-100-empty]] empty item",
		);

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-empty-body", { title: "TEST_PLAN", itemId: "PLAN-100-test" })).rejects.toThrow(
			"empty or minimal bodies (< 100 chars)",
		);
	});

	it("rejects child items with body under 100 characters", async () => {
		await writeOrgItem("features", "FEAT-101-thin", "Short body that is not enough.");
		await writeOrgItem(
			"plans",
			"PLAN-101-test",
			"* Context\nTest\n\n* Execution Manifest\n- [[id:FEAT-101-thin]] thin item",
		);

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-thin-body", { title: "TEST_PLAN", itemId: "PLAN-101-test" })).rejects.toThrow(
			"FEAT-101-thin",
		);
	});

	it("rejects child items missing EFFORT property", async () => {
		await writeOrgItem("features", "FEAT-102-no-effort", VALID_BODY, { effort: "" });
		await writeOrgItem(
			"plans",
			"PLAN-102-test",
			"* Context\nTest\n\n* Execution Manifest\n- [[id:FEAT-102-no-effort]] missing effort",
		);

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-no-effort", { title: "TEST_PLAN", itemId: "PLAN-102-test" })).rejects.toThrow(
			"EFFORT",
		);
	});

	it("rejects child items missing PRIORITY property", async () => {
		await writeOrgItem("features", "FEAT-103-no-priority", VALID_BODY, { priority: "" });
		await writeOrgItem(
			"plans",
			"PLAN-103-test",
			"* Context\nTest\n\n* Execution Manifest\n- [[id:FEAT-103-no-priority]] missing priority",
		);

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-no-priority", { title: "TEST_PLAN", itemId: "PLAN-103-test" })).rejects.toThrow(
			"PRIORITY",
		);
	});

	it("rejects child items missing LAYER property", async () => {
		await writeOrgItem("features", "FEAT-104-no-layer", VALID_BODY, { layer: "" });
		await writeOrgItem(
			"plans",
			"PLAN-104-test",
			"* Context\nTest\n\n* Execution Manifest\n- [[id:FEAT-104-no-layer]] missing layer",
		);

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-no-layer", { title: "TEST_PLAN", itemId: "PLAN-104-test" })).rejects.toThrow(
			"LAYER",
		);
	});

	it("rejects broken DEPENDS references", async () => {
		await writeOrgItem("features", "FEAT-105-dep", VALID_BODY);
		// Write FEAT-105-dep with a DEPENDS pointing to an item NOT in this plan
		const depDir = path.join(tmpDir, "!tasks", "features");
		await Bun.write(
			path.join(depDir, "FEAT-105-dep.org"),
			[
				"#+TITLE: FEAT-105-dep",
				"#+CUSTOM_ID: FEAT-105-dep",
				"#+STATE: ITEM",
				"#+EFFORT: 1h",
				"#+PRIORITY: #A",
				"#+LAYER: backend",
				"#+DEPENDS: FEAT-999-nonexistent",
				"",
				VALID_BODY,
				"",
			].join("\n"),
		);
		await writeOrgItem(
			"plans",
			"PLAN-105-test",
			"* Context\nTest\n\n* Execution Manifest\n- [[id:FEAT-105-dep]] dep item",
		);

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-broken-deps", { title: "TEST_PLAN", itemId: "PLAN-105-test" })).rejects.toThrow(
			"FEAT-999-nonexistent",
		);
	});

	it("passes when all validations are satisfied", async () => {
		await writeOrgItem("features", "FEAT-200-valid", VALID_BODY);
		await writeOrgItem(
			"plans",
			"PLAN-200-test",
			"* Context\nValid plan\n\n* Execution Manifest\n- [[id:FEAT-200-valid]] valid item (1h)",
		);

		const tool = new ExitPlanModeTool(createSession());
		const result = await tool.execute("call-valid", { title: "TEST_PLAN", itemId: "PLAN-200-test" });

		expect(result.details?.childItemIds).toEqual(["FEAT-200-valid"]);
		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("Plan ready for approval") });
	});

	it("accepts valid DEPENDS within the plan", async () => {
		await writeOrgItem("features", "FEAT-201-base", VALID_BODY);
		// Write FEAT-201-consumer with DEPENDS on FEAT-201-base (both in plan)
		const depDir = path.join(tmpDir, "!tasks", "features");
		await Bun.write(
			path.join(depDir, "FEAT-201-consumer.org"),
			[
				"#+TITLE: FEAT-201-consumer",
				"#+CUSTOM_ID: FEAT-201-consumer",
				"#+STATE: ITEM",
				"#+EFFORT: 2h",
				"#+PRIORITY: #A",
				"#+LAYER: backend",
				"#+DEPENDS: FEAT-201-base",
				"",
				VALID_BODY,
				"",
			].join("\n"),
		);
		await writeOrgItem(
			"plans",
			"PLAN-201-test",
			"* Context\nDep test\n\n* Execution Manifest\n- [[id:FEAT-201-base]] base (1h)\n- [[id:FEAT-201-consumer]] consumer (2h, depends FEAT-201-base)",
		);

		const tool = new ExitPlanModeTool(createSession());
		const result = await tool.execute("call-valid-deps", { title: "TEST_PLAN", itemId: "PLAN-201-test" });

		expect(result.details?.childItemIds).toContain("FEAT-201-base");
		expect(result.details?.childItemIds).toContain("FEAT-201-consumer");
	});

	it("reports all missing properties in one error", async () => {
		await writeOrgItem("features", "FEAT-106-bare", VALID_BODY, { effort: "", priority: "", layer: "" });
		await writeOrgItem(
			"plans",
			"PLAN-106-test",
			"* Context\nTest\n\n* Execution Manifest\n- [[id:FEAT-106-bare]] bare item",
		);

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-all-missing", { title: "TEST_PLAN", itemId: "PLAN-106-test" })).rejects.toThrow(
			/EFFORT.*PRIORITY.*LAYER/,
		);
	});
});
