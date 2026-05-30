import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { resolvePlanItem } from "@spell/pi-coding-agent/plan-mode/org-plan";

describe("resolvePlanItem", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "org-plan-properties-"));
		const plansDir = path.join(tmpDir, "!tasks", "plans");
		await fs.mkdir(plansDir, { recursive: true });
		await Bun.write(
			path.join(plansDir, "PLAN-001-layered.org"),
			[
				"#+TITLE: PLAN-001-layered",
				"#+CUSTOM_ID: PLAN-001-layered",
				"#+STATE: INIT",
				"#+LAYER: backend",
				"#+OWNER: platform",
				"",
				"* Context",
				"Layered plan body",
			].join("\n"),
		);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns org item properties alongside id file and body", async () => {
		const settings = Settings.isolated();

		const item = await resolvePlanItem(settings, tmpDir, "PLAN-001-layered");

		expect(item).not.toBeNull();
		expect(item).toMatchObject({
			id: "PLAN-001-layered",
			body: "* Context\nLayered plan body",
			properties: {
				CUSTOM_ID: "PLAN-001-layered",
				LAYER: "backend",
				OWNER: "platform",
			},
		});
		expect(item?.file).toBe(path.join(tmpDir, "!tasks", "plans", "PLAN-001-layered.org"));
	});
});
