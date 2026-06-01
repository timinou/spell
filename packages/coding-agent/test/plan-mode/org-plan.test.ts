import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { approvePlanItem, completePlanItem } from "@spell/pi-coding-agent/plan-mode/org-plan";

describe("approvePlanItem", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "org-plan-approve-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function writePlanItem(id: string, body: string): Promise<string> {
		const plansDir = path.join(tmpDir, "!tasks", "plans");
		await fs.mkdir(plansDir, { recursive: true });
		const filePath = path.join(plansDir, `${id}.org`);
		const content = [`#+TITLE: ${id}`, `#+CUSTOM_ID: ${id}`, "#+STATE: INIT", "#+LAYER: backend", "", body, ""].join(
			"\n",
		);
		await Bun.write(filePath, content);
		return filePath;
	}

	it("transitions PLAN from INIT to DOING", async () => {
		const planId = "PLAN-001-auth-rollout";
		const planFile = await writePlanItem(planId, "* Context\nExisting plan body");
		const settings = Settings.isolated();

		const approved = await approvePlanItem(settings, tmpDir, { id: planId, file: planFile });
		expect(approved).toEqual({ id: planId, transcriptPath: undefined });

		const updated = await Bun.file(planFile).text();
		expect(updated).toContain("#+STATE: DOING");
		expect(updated).not.toContain("#+STATE: INIT");
	});

	it("prepends initial message section when provided", async () => {
		const planId = "PLAN-002-auth-rollout";
		const planFile = await writePlanItem(planId, "* Context\nOriginal body");
		const settings = Settings.isolated();

		await approvePlanItem(settings, tmpDir, { id: planId, file: planFile }, "User asked for strict auth checks");

		const updated = await Bun.file(planFile).text();
		expect(updated).toContain("* Initial message\n\nUser asked for strict auth checks");
		expect(updated).toContain("* Context\nOriginal body");
	});

	it("extracts transcript path from org file", async () => {
		const planId = "PLAN-004-transcript-test";
		const plansDir = path.join(tmpDir, "!tasks", "plans");
		await fs.mkdir(plansDir, { recursive: true });
		const planFile = path.join(plansDir, `${planId}.org`);
		const content = [
			`#+TITLE: ${planId}`,
			`#+CUSTOM_ID: ${planId}`,
			"#+STATE: INIT",
			"#+TRANSCRIPT_PATH: [[file:/tmp/session.jsonl]]",
			"",
			"* Context",
			"Plan body",
			"",
		].join("\n");
		await Bun.write(planFile, content);
		const settings = Settings.isolated();

		const approved = await approvePlanItem(settings, tmpDir, { id: planId, file: planFile });
		expect(approved).toEqual({ id: planId, transcriptPath: "/tmp/session.jsonl" });
	});

	it("returns null when org is disabled", async () => {
		const planId = "PLAN-003-auth-rollout";
		const planFile = await writePlanItem(planId, "* Context\nOriginal body");
		const settings = Settings.isolated({ "org.enabled": false });

		const result = await approvePlanItem(settings, tmpDir, { id: planId, file: planFile });
		expect(result).toBeNull();
	});
});

describe("completePlanItem", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "org-plan-complete-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function writeOrgItem(id: string, state: string, body: string): Promise<string> {
		const plansDir = path.join(tmpDir, "!tasks", "plans");
		await fs.mkdir(plansDir, { recursive: true });
		const filePath = path.join(plansDir, `${id}.org`);
		const content = [
			`#+TITLE: ${id}`,
			`#+CUSTOM_ID: ${id}`,
			`#+STATE: ${state}`,
			"#+LAYER: backend",
			"",
			body,
			"",
		].join("\n");
		await Bun.write(filePath, content);
		return filePath;
	}

	it("closes DOING plan and reconciles linked children truthfully", async () => {
		const planId = "PLAN-100-rollout";
		const doingChildId = "ITEM-100-doing-child";
		const itemChildId = "ITEM-101-item-child";
		const reviewChildId = "ITEM-102-review-child";
		const blockedChildId = "ITEM-103-blocked-child";
		const doneChildId = "ITEM-104-done-child";
		const initChildId = "ITEM-105-init-child";
		const waitingChildId = "ITEM-106-waiting-child";

		const planFile = await writeOrgItem(
			planId,
			"DOING",
			[
				"* Steps",
				`- [[id:${doingChildId}]]`,
				`- [[id:${itemChildId}]]`,
				`- [[id:${reviewChildId}]]`,
				`- [[id:${blockedChildId}]]`,
				`- [[id:${doneChildId}]]`,
				`- [[id:${initChildId}]]`,
				`- [[id:${waitingChildId}]]`,
				`- duplicate [[id:${doingChildId}]]`,
			].join("\n"),
		);
		await writeOrgItem(doingChildId, "DOING", "* child");
		await writeOrgItem(itemChildId, "ITEM", "* child");
		await writeOrgItem(reviewChildId, "REVIEW", "* child");
		await writeOrgItem(blockedChildId, "BLOCKED", "* child");
		await writeOrgItem(doneChildId, "DONE", "* child");
		await writeOrgItem(initChildId, "INIT", "* child");
		await writeOrgItem(waitingChildId, "WAITING", "* child");
		const settings = Settings.isolated();

		const result = await completePlanItem(settings, tmpDir, { id: planId, file: planFile });
		expect(result).not.toBeNull();
		expect(result?.linkedChildIds).toEqual([
			doingChildId,
			itemChildId,
			reviewChildId,
			blockedChildId,
			doneChildId,
			initChildId,
			waitingChildId,
		]);
		expect(result?.completedChildIds.sort()).toEqual([doingChildId, itemChildId, reviewChildId, initChildId].sort());
		expect(result?.skippedBlockedChildIds).toEqual([blockedChildId]);
		expect(result?.skippedDoneChildIds).toEqual([doneChildId]);
		expect(result?.skippedOtherChildIds).toEqual([waitingChildId]);

		const planUpdated = await Bun.file(planFile).text();
		expect(planUpdated).toContain("#+STATE: DONE");
		expect(planUpdated).not.toContain("#+STATE: DOING");

		const doingUpdated = await Bun.file(path.join(tmpDir, "!tasks", "plans", `${doingChildId}.org`)).text();
		const itemUpdated = await Bun.file(path.join(tmpDir, "!tasks", "plans", `${itemChildId}.org`)).text();
		const reviewUpdated = await Bun.file(path.join(tmpDir, "!tasks", "plans", `${reviewChildId}.org`)).text();
		const blockedUpdated = await Bun.file(path.join(tmpDir, "!tasks", "plans", `${blockedChildId}.org`)).text();
		const doneUpdated = await Bun.file(path.join(tmpDir, "!tasks", "plans", `${doneChildId}.org`)).text();
		const initUpdated = await Bun.file(path.join(tmpDir, "!tasks", "plans", `${initChildId}.org`)).text();
		const waitingUpdated = await Bun.file(path.join(tmpDir, "!tasks", "plans", `${waitingChildId}.org`)).text();

		expect(doingUpdated).toContain("#+STATE: DONE");
		expect(itemUpdated).toContain("#+STATE: DONE");
		expect(reviewUpdated).toContain("#+STATE: DONE");
		expect(blockedUpdated).toContain("#+STATE: BLOCKED");
		expect(doneUpdated).toContain("#+STATE: DONE");
		expect(initUpdated).toContain("#+STATE: DONE");
		expect(waitingUpdated).toContain("#+STATE: WAITING");
	});

	it("throws when linked child cannot be resolved and does not close plan", async () => {
		const planId = "PLAN-105-rollout";
		const missingChildId = "ITEM-999-missing";
		const planFile = await writeOrgItem(planId, "DOING", `* Steps\n- [[id:${missingChildId}]]`);
		const settings = Settings.isolated();

		await expect(completePlanItem(settings, tmpDir, { id: planId, file: planFile })).rejects.toThrow(
			`Linked child item "${missingChildId}" from plan "${planId}" was not found.`,
		);

		const updatedPlan = await Bun.file(planFile).text();
		expect(updatedPlan).toContain("#+STATE: DOING");
		expect(updatedPlan).not.toContain("#+STATE: DONE");
	});

	it("appends completion report verbatim when provided", async () => {
		const planId = "PLAN-110-rollout";
		const planFile = await writeOrgItem(planId, "DOING", "* Existing\nBody");
		const completionReport = ["** Completion [2026-03-28]", "", "*** Verification", "- All checks passed"].join("\n");
		const settings = Settings.isolated();

		await completePlanItem(settings, tmpDir, { id: planId, file: planFile }, { completionReport });

		const updated = await Bun.file(planFile).text();
		expect(updated).toContain("* Existing\nBody");
		expect(updated).toContain(completionReport);
	});

	it("returns null when org is disabled", async () => {
		const planId = "PLAN-120-rollout";
		const planFile = await writeOrgItem(planId, "DOING", "* Existing\nBody");
		const settings = Settings.isolated({ "org.enabled": false });

		const result = await completePlanItem(settings, tmpDir, { id: planId, file: planFile });
		expect(result).toBeNull();
	});
});
