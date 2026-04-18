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
		props?: { layer?: string; depends?: string },
	): Promise<void> {
		const categoryDir = path.join(tmpDir, "!tasks", category);
		await fs.mkdir(categoryDir, { recursive: true });
		const lines = [`#+TITLE: ${id}`, `#+CUSTOM_ID: ${id}`, "#+STATE: ITEM"];
		if (props?.layer !== undefined) lines.push(`#+LAYER: ${props.layer}`);
		else lines.push("#+LAYER: backend");
		if (props?.depends !== undefined) lines.push(`#+DEPENDS: ${props.depends}`);
		lines.push("", body, "");
		await Bun.write(path.join(categoryDir, `${id}.org`), lines.join("\n"));
	}

	function buildPlanBody(...childIds: string[]): string {
		return [
			"* Context",
			"Validation test",
			"",
			"* Execution Manifest",
			...childIds.map(id => `- [[id:${id}]] ${id}`),
		].join("\n");
	}

	function buildValidBody(
		itemId: string,
		options?: {
			defineId?: string;
			testId?: string;
			implId?: string;
			testDepends?: string;
			implDepends?: string;
		},
	): string {
		const defineId = options?.defineId ?? `${itemId}::define-types`;
		const testId = options?.testId ?? `${itemId}::auth-tests`;
		const implId = options?.implId ?? `${itemId}::implement-auth`;
		const testDepends = options?.testDepends ?? defineId;
		const implDepends = options?.implDepends ?? testId;
		const testDependsLine = testDepends ? [`:DEPENDS: ${testDepends}`] : [];
		const implDependsLine = implDepends ? [`:DEPENDS: ${implDepends}`] : [];

		return [
			"* Scope",
			"Implement the authentication API with JWT tokens, refresh sessions, and consistent auth error handling.",
			"",
			"* Existing Patterns",
			"Reuse src/auth.ts and the middleware conventions from src/middleware/auth.ts instead of inventing a new flow.",
			"",
			"* Tests",
			"- test/auth.test.ts covers login success, invalid credentials, token expiry, and session revocation.",
			"",
			"* Implementation",
			"** Define TypeScript interfaces",
			":PROPERTIES:",
			`:CUSTOM_ID: ${defineId}`,
			":END:",
			"- File: src/auth/types.ts",
			"",
			"** Write auth tests",
			":PROPERTIES:",
			`:CUSTOM_ID: ${testId}`,
			...testDependsLine,
			":END:",
			"- File: test/auth.test.ts",
			"- Start with failing contract tests for login, invalid credentials, and token refresh.",
			"",
			"** Implement auth flow",
			":PROPERTIES:",
			`:CUSTOM_ID: ${implId}`,
			...implDependsLine,
			":END:",
			"- File: src/auth.ts",
			"- Reuse middleware patterns from src/middleware/auth.ts and satisfy the test scenarios above.",
			"",
			"* Edge Cases",
			"- Invalid credentials return 401 and do not create a session.",
			"- Expired tokens return a typed auth error without leaking implementation details.",
			"",
			"* Acceptance Criteria",
			"- POST /api/auth/login returns a valid JWT on correct credentials.",
			"- Invalid credentials return 401 with an error message.",
		].join("\n");
	}

	const THIN_BODY = ["* Scope", "Too small."].join("\n");
	const LEGACY_BODY = [
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
		await writeOrgItem("plans", "PLAN-100-test", buildPlanBody("FEAT-100-empty"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-empty-body", { title: "TEST_PLAN", itemId: "PLAN-100-test" })).rejects.toThrow(
			"empty or minimal bodies (< 100 chars)",
		);
	});

	it("rejects child items with body under 100 characters", async () => {
		await writeOrgItem("features", "FEAT-101-thin", THIN_BODY);
		await writeOrgItem("plans", "PLAN-101-test", buildPlanBody("FEAT-101-thin"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-thin-body", { title: "TEST_PLAN", itemId: "PLAN-101-test" })).rejects.toThrow(
			"FEAT-101-thin",
		);
	});

	it("reports all missing top-level properties in one error", async () => {
		await writeOrgItem("features", "FEAT-102-bare", buildValidBody("FEAT-102-bare"), {
			layer: "",
		});
		await writeOrgItem("plans", "PLAN-102-test", buildPlanBody("FEAT-102-bare"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-all-missing", { title: "TEST_PLAN", itemId: "PLAN-102-test" })).rejects.toThrow(
			/LAYER/,
		);
	});

	it("rejects broken top-level DEPENDS references", async () => {
		await writeOrgItem("features", "FEAT-103-dep", buildValidBody("FEAT-103-dep"), {
			depends: "FEAT-999-nonexistent",
		});
		await writeOrgItem("plans", "PLAN-103-test", buildPlanBody("FEAT-103-dep"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-broken-deps", { title: "TEST_PLAN", itemId: "PLAN-103-test" })).rejects.toThrow(
			"FEAT-999-nonexistent",
		);
	});

	it("rejects child items missing structured sub-outline CUSTOM_IDs", async () => {
		await writeOrgItem("features", "FEAT-104-legacy", LEGACY_BODY);
		await writeOrgItem("plans", "PLAN-104-test", buildPlanBody("FEAT-104-legacy"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(
			tool.execute("call-missing-suboutlines", { title: "TEST_PLAN", itemId: "PLAN-104-test" }),
		).rejects.toThrow("FILE-LEVEL-ID::suboutline-id");
	});

	it("rejects sub-outline CUSTOM_IDs outside the owning child namespace", async () => {
		await writeOrgItem(
			"features",
			"FEAT-105-namespace",
			buildValidBody("FEAT-105-namespace", { defineId: "WRONG::define-types" }),
		);
		await writeOrgItem("plans", "PLAN-105-test", buildPlanBody("FEAT-105-namespace"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-bad-namespace", { title: "TEST_PLAN", itemId: "PLAN-105-test" })).rejects.toThrow(
			"WRONG::define-types",
		);
	});

	it("rejects broken sub-outline DEPENDS references", async () => {
		await writeOrgItem(
			"features",
			"FEAT-106-subdep",
			buildValidBody("FEAT-106-subdep", { implDepends: "FEAT-999::missing-step" }),
		);
		await writeOrgItem("plans", "PLAN-106-test", buildPlanBody("FEAT-106-subdep"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(
			tool.execute("call-broken-subdeps", { title: "TEST_PLAN", itemId: "PLAN-106-test" }),
		).rejects.toThrow("FEAT-999::missing-step");
	});

	it("rejects duplicate sub-outline CUSTOM_IDs within a child item", async () => {
		await writeOrgItem(
			"features",
			"FEAT-108-duplicate",
			buildValidBody("FEAT-108-duplicate", { testId: "FEAT-108-duplicate::define-types" }),
		);
		await writeOrgItem("plans", "PLAN-107-test", buildPlanBody("FEAT-108-duplicate"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(
			tool.execute("call-duplicate-subids", { title: "TEST_PLAN", itemId: "PLAN-107-test" }),
		).rejects.toThrow(/duplicate suboutline id|globally unique/);
	});

	it("rejects cyclic sub-outline DEPENDS graphs", async () => {
		const itemId = "FEAT-109-cycle";
		await writeOrgItem(
			"features",
			itemId,
			buildValidBody(itemId, {
				testDepends: `${itemId}::implement-auth`,
				implDepends: `${itemId}::auth-tests`,
			}),
		);
		await writeOrgItem("plans", "PLAN-109-test", buildPlanBody(itemId));

		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-cycle", { title: "TEST_PLAN", itemId: "PLAN-109-test" })).rejects.toThrow(
			/acyclic|cyclic suboutline depends/,
		);
	});

	it("reports thin bodies and missing properties together", async () => {
		await writeOrgItem("features", "FEAT-110-combined", THIN_BODY, {
			layer: "",
		});
		await writeOrgItem("plans", "PLAN-110-test", buildPlanBody("FEAT-110-combined"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(
			tool.execute("call-combined-thin-props", { title: "TEST_PLAN", itemId: "PLAN-110-test" }),
		).rejects.toThrow(/empty or minimal bodies|thin child body[\s\S]*LAYER/);
	});

	it("reports broken top-level deps and bad sub-outline namespaces together", async () => {
		await writeOrgItem(
			"features",
			"FEAT-111-multi",
			buildValidBody("FEAT-111-multi", { defineId: "WRONG::define-types" }),
			{ depends: "FEAT-999-missing" },
		);
		await writeOrgItem("plans", "PLAN-111-test", buildPlanBody("FEAT-111-multi"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(
			tool.execute("call-combined-namespace-deps", { title: "TEST_PLAN", itemId: "PLAN-111-test" }),
		).rejects.toThrow(/FEAT-999-missing[\s\S]*WRONG::define-types|WRONG::define-types[\s\S]*FEAT-999-missing/);
	});

	it("reports issues across multiple child items in one response", async () => {
		await writeOrgItem("features", "FEAT-112-thin", THIN_BODY);
		await writeOrgItem(
			"features",
			"FEAT-113-broken-deps",
			buildValidBody("FEAT-113-broken-deps", { implDepends: "FEAT-999::missing-step" }),
		);
		await writeOrgItem("plans", "PLAN-112-test", buildPlanBody("FEAT-112-thin", "FEAT-113-broken-deps"));

		const tool = new ExitPlanModeTool(createSession());
		await expect(
			tool.execute("call-multi-item-issues", { title: "TEST_PLAN", itemId: "PLAN-112-test" }),
		).rejects.toThrow(/FEAT-112-thin[\s\S]*FEAT-999::missing-step|FEAT-999::missing-step[\s\S]*FEAT-112-thin/);
	});

	it("accepts valid top-level and sub-outline dependencies within the plan", async () => {
		await writeOrgItem("features", "FEAT-200-base", buildValidBody("FEAT-200-base"));
		await writeOrgItem("features", "FEAT-201-consumer", buildValidBody("FEAT-201-consumer"), {
			depends: "FEAT-200-base",
		});
		await writeOrgItem("plans", "PLAN-200-test", buildPlanBody("FEAT-200-base", "FEAT-201-consumer"));

		const tool = new ExitPlanModeTool(createSession());
		const result = await tool.execute("call-valid", { title: "TEST_PLAN", itemId: "PLAN-200-test" });

		expect(result.details?.childItemIds).toEqual(["FEAT-200-base", "FEAT-201-consumer"]);
		expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("Plan ready for approval") });
	});
});
