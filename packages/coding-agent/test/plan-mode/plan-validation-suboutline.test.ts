import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { formatPlanValidationIssues, validatePlanItem } from "../../src/plan-mode/plan-validation";

let tmpDir: string;
let settings: Settings;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-validation-suboutline-"));
	await fs.mkdir(path.join(tmpDir, "!tasks", "plans"), { recursive: true });
	await fs.mkdir(path.join(tmpDir, "!tasks", "features"), { recursive: true });
	settings = Settings.isolated();
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedPlan(id: string, body: string): Promise<void> {
	await Bun.write(
		path.join(tmpDir, "!tasks", "plans", `${id}.org`),
		`#+TITLE: ${id}\n#+STATE: ITEM\n#+CUSTOM_ID: ${id}\n\n${body}\n`,
	);
}

async function seedFeature(id: string, layer: string, body: string): Promise<void> {
	await Bun.write(
		path.join(tmpDir, "!tasks", "features", `${id}.org`),
		`#+TITLE: ${id}\n#+STATE: ITEM\n#+CUSTOM_ID: ${id}\n#+LAYER: ${layer}\n\n${body}\n`,
	);
}

function detailedFeatureBody(id: string, suboutlines: string[]): string {
	return [
		`This child item ${id} includes enough implementation detail to satisfy the validator body threshold and describe files, acceptance criteria, edge cases, and rollout notes for the implementing agent.`,
		...suboutlines,
	].join("\n");
}

describe("validatePlanItem dual-link manifest", () => {
	test("validator_handles_frontmatter_only_plan_without_final_newline", async () => {
		await Bun.write(
			path.join(tmpDir, "!tasks", "plans", "PLAN-EOF.org"),
			["#+TITLE: EOF Plan", "#+STATE: ITEM", "#+CUSTOM_ID: PLAN-EOF", "#+LAYER: org"].join("\n"),
		);

		const result = await validatePlanItem(settings, tmpDir, "PLAN-EOF");

		expect(result).not.toBeNull();
		expect(result?.valid).toBe(false);
		expect(result?.planItem.body).toBe("");
		expect(result?.issues.map(issue => issue.category)).toEqual(["missing-child-links"]);
	});

	test("validator_accepts_dual_link_manifest", async () => {
		await seedFeature(
			"FEAT-100",
			"backend",
			detailedFeatureBody("FEAT-100", [
				"** ITEM Define API",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-100::api",
				":END:",
				"** ITEM Implement API",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-100::impl",
				":DEPENDS: FEAT-100::api",
				":END:",
			]),
		);
		await seedFeature(
			"FEAT-200",
			"backend",
			detailedFeatureBody("FEAT-200", [
				"** ITEM Shared types",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-200::types",
				":END:",
			]),
		);
		await seedPlan(
			"PLAN-200",
			[
				"* Context",
				"- [[id:FEAT-100]]",
				"- [[id:FEAT-200]]",
				"* Execution Manifest",
				"** wave-1 :wave:",
				"- [[id:FEAT-100::api]] Define API",
				"- [[id:FEAT-200::types]] Shared types",
				"** wave-2 :wave:",
				"- [[id:FEAT-100::impl]] Implement API",
			].join("\n"),
		);

		const result = await validatePlanItem(settings, tmpDir, "PLAN-200");
		expect(result?.valid).toBe(true);
	});

	test("validator_rejects_sub_outline_link_without_top_level", async () => {
		await seedFeature(
			"FEAT-100",
			"backend",
			detailedFeatureBody("FEAT-100", ["** ITEM Define API", ":PROPERTIES:", ":CUSTOM_ID: FEAT-100::api", ":END:"]),
		);
		await seedPlan("PLAN-201", "* Execution Manifest\n** wave-1 :wave:\n- [[id:FEAT-100::api]] Define API");

		const result = await validatePlanItem(settings, tmpDir, "PLAN-201");
		expect(result?.valid).toBe(false);
		expect(result?.issues.map(issue => issue.category)).toContain("missing-top-level-link");
		expect(result?.issues.find(issue => issue.category === "missing-top-level-link")?.items).toEqual([
			"FEAT-100 (required by sub-outline FEAT-100::api)",
		]);
	});

	test("validator_rejects_top_level_without_manifest_coverage", async () => {
		await seedFeature(
			"FEAT-100",
			"backend",
			detailedFeatureBody("FEAT-100", [
				"** ITEM Define API",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-100::api",
				":END:",
				"** ITEM Implement API",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-100::impl",
				":END:",
			]),
		);
		await seedPlan("PLAN-202", "* Context\n- [[id:FEAT-100]]");

		const result = await validatePlanItem(settings, tmpDir, "PLAN-202");
		expect(result?.issues.map(issue => issue.category)).toContain("manifest-missing-suboutlines");
	});

	test("validator_rejects_phantom_sub_outline_link_and_missing_suboutline_links", async () => {
		await seedFeature(
			"FEAT-100",
			"backend",
			detailedFeatureBody("FEAT-100", [
				"** ITEM Define API",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-100::api",
				":END:",
				"** ITEM Implement API",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-100::impl",
				":END:",
			]),
		);
		await seedPlan(
			"PLAN-203",
			[
				"* Context",
				"- [[id:FEAT-100]]",
				"* Execution Manifest",
				"** wave-1 :wave:",
				"- [[id:FEAT-100::bogus]] Phantom",
			].join("\n"),
		);

		const result = await validatePlanItem(settings, tmpDir, "PLAN-203");
		expect(result?.issues.map(issue => issue.category)).toContain("missing-suboutline-declaration");
		expect(result?.issues.map(issue => issue.category)).toContain("missing-suboutline-link");
	});

	test("validator_accepts_top_level_link_when_child_has_no_sub_outlines", async () => {
		await seedFeature(
			"FEAT-300",
			"backend",
			"This child item has a long enough body to pass validation without any structured sub-outline declarations. It still documents implementation details, files, acceptance criteria, and rollback notes clearly.",
		);
		await seedPlan("PLAN-204", "* Context\n- [[id:FEAT-300]]");

		const result = await validatePlanItem(settings, tmpDir, "PLAN-204");
		expect(result?.valid).toBe(true);
	});

	test("validator_accepts_dag_sections_with_already_declared_links", async () => {
		await seedFeature(
			"FEAT-400",
			"backend",
			detailedFeatureBody("FEAT-400", ["** ITEM Define API", ":PROPERTIES:", ":CUSTOM_ID: FEAT-400::api", ":END:"]),
		);
		await seedPlan(
			"PLAN-400",
			[
				"* Context",
				"- [[id:FEAT-400]]",
				"* Execution Manifest",
				"** wave-1 :wave:",
				"- [[id:FEAT-400::api]] Define API",
				"** File-level DAG",
				"- [[id:FEAT-400]] Feature node",
				"** Subfeature-level DAG",
				"- [[id:FEAT-400::api]] Subfeature node",
			].join("\n"),
		);

		const result = await validatePlanItem(settings, tmpDir, "PLAN-400");
		expect(result?.valid).toBe(true);
	});

	test("validator_accepts_dag_sections_with_code_form_ids", async () => {
		await seedFeature(
			"FEAT-401",
			"backend",
			detailedFeatureBody("FEAT-401", ["** ITEM Define API", ":PROPERTIES:", ":CUSTOM_ID: FEAT-401::api", ":END:"]),
		);
		await seedPlan(
			"PLAN-401",
			[
				"* Context",
				"- [[id:FEAT-401]]",
				"* Execution Manifest",
				"** wave-1 :wave:",
				"- [[id:FEAT-401::api]] Define API",
				"** File-level DAG",
				"- `FEAT-401` Feature node",
				"** Subfeature-level DAG",
				"- `FEAT-401::api` Subfeature node",
			].join("\n"),
		);

		const result = await validatePlanItem(settings, tmpDir, "PLAN-401");
		expect(result?.valid).toBe(true);
	});

	test("validator_reports_missing_suboutline_link_hints", async () => {
		const formatted = formatPlanValidationIssues("PLAN-999", [
			{
				category: "missing-top-level-link",
				message: "m1",
				items: ["FEAT-100 (required by sub-outline FEAT-100::api)"],
			},
			{ category: "missing-suboutline-link", message: "m2", items: ["FEAT-100::impl"] },
			{
				category: "missing-suboutline-declaration",
				message: "m3",
				items: ["FEAT-100::bogus not declared in FEAT-100"],
			},
			{
				category: "manifest-missing-suboutlines",
				message: "m4",
				items: ["FEAT-100 declares sub-outlines but none linked in PLAN body"],
			},
		]);
		expect(formatted).toContain("missing top level link");
		expect(formatted).toContain("missing suboutline link");
		expect(formatted).toContain("missing suboutline declaration");
		expect(formatted).toContain("manifest missing suboutlines");
	});
});
