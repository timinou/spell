import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { approvePlanItem } from "@oh-my-pi/pi-coding-agent/plan-mode/org-plan";

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
		const content = [
			`#+TITLE: ${id}`,
			`#+CUSTOM_ID: ${id}`,
			"#+STATE: INIT",
			"#+EFFORT: 2h",
			"#+PRIORITY: #A",
			"#+LAYER: backend",
			"",
			body,
			"",
		].join("\n");
		await Bun.write(filePath, content);
		return filePath;
	}

	it("transitions PLAN from INIT to DOING", async () => {
		const planId = "PLAN-001-auth-rollout";
		const planFile = await writePlanItem(planId, "* Context\nExisting plan body");
		const settings = Settings.isolated();

		const approvedId = await approvePlanItem(settings, tmpDir, { id: planId, file: planFile });
		expect(approvedId).toBe(planId);

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

	it("returns null when org is disabled", async () => {
		const planId = "PLAN-003-auth-rollout";
		const planFile = await writePlanItem(planId, "* Context\nOriginal body");
		const settings = Settings.isolated({ "org.enabled": false });

		const result = await approvePlanItem(settings, tmpDir, { id: planId, file: planFile });
		expect(result).toBeNull();
	});
});
