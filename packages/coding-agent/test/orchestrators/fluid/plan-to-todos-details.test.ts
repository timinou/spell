import { describe, expect, test } from "bun:test";
import { extractChildBodySection, type PlanWave, planWavesToTodoGroups } from "../../../src/orchestrators/fluid";

const FEATURE_ID = "FEAT-601-inject-linked-child-org-bodies-into-appr";
const SUBOUTLINE_ID = `${FEATURE_ID}::s4-template`;
const FEATURE_BODY = [
	"* Scope",
	"Thread every linked child item into the approved plan prompt.",
	"",
	"* Existing Patterns",
	"Keep existing prompt rendering behavior intact.",
	"",
	"** s4",
	":PROPERTIES:",
	`:CUSTOM_ID: ${SUBOUTLINE_ID}`,
	`:DEPENDS: ${FEATURE_ID}::s3-tests`,
	":END:",
	"- File: src/prompts/system/plan-mode-approved.md",
	"- Insert block",
	"",
	"** s5",
	":PROPERTIES:",
	`:CUSTOM_ID: ${FEATURE_ID}::s5-thread`,
	":END:",
	"- Thread through interactive mode.",
].join("\n");

describe("plan-to-todos child body enrichment", () => {
	test("extracts the matching sub-outline body without the properties drawer", () => {
		const result = extractChildBodySection(SUBOUTLINE_ID, new Map([[FEATURE_ID, FEATURE_BODY]]), 4096);
		expect(result).toBe(["- File: src/prompts/system/plan-mode-approved.md", "- Insert block"].join("\n"));
	});

	test("extracts the top-level preamble for bare child ids", () => {
		const result = extractChildBodySection(FEATURE_ID, new Map([[FEATURE_ID, FEATURE_BODY]]), 4096);
		expect(result).toBe("Thread every linked child item into the approved plan prompt.");
	});

	test("returns undefined when the requested sub-outline does not exist", () => {
		expect(
			extractChildBodySection(`${FEATURE_ID}::missing`, new Map([[FEATURE_ID, FEATURE_BODY]]), 4096),
		).toBeUndefined();
	});

	test("merges existing details above the sliced child section", () => {
		const waves: PlanWave[] = [
			{
				name: "wave-1",
				entries: [
					{
						id: SUBOUTLINE_ID,
						orgItemId: SUBOUTLINE_ID,
						step: "Insert block",
						details: ["Effort: 3h", "Priority: #A"].join("\n"),
					},
				],
			},
		];
		const groups = planWavesToTodoGroups(waves, {
			planItemId: "PLAN-1",
			childBodiesById: new Map([[FEATURE_ID, FEATURE_BODY]]),
			todoDetailsMaxBytes: 4096,
		});
		expect(groups[0]?.planItemId).toBe("PLAN-1");
		expect(groups[0]?.tasks[0]?.details).toBe(
			["Effort: 3h", "Priority: #A", "", "- File: src/prompts/system/plan-mode-approved.md", "- Insert block"].join(
				"\n",
			),
		);
	});

	test("preserves backcompat when no child bodies are supplied", () => {
		const waves: PlanWave[] = [
			{
				name: "wave-1",
				entries: [{ id: "FEAT-1", orgItemId: "FEAT-1", step: "Do work", details: "Existing details" }],
			},
		];
		const groups = planWavesToTodoGroups(waves, { planItemId: "PLAN-1" });
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({
			id: "group-1",
			name: "wave-1",
			planItemId: "PLAN-1",
			waveIndex: 1,
		});
		expect(groups[0]?.tasks[0]).toMatchObject({
			id: "task-1",
			content: "Do work",
			status: "in_progress",
			details: "Existing details",
			blockers: undefined,
			orgItemId: "FEAT-1",
			layer: undefined,
			orgItemClosingId: "FEAT-1",
		});
	});

	test("truncates sliced details safely and appends the fetch marker", () => {
		const result = extractChildBodySection(
			SUBOUTLINE_ID,
			new Map([[FEATURE_ID, FEATURE_BODY.replace("- Insert block", `${"🙂".repeat(2_000)}`)]]),
			4096,
		);
		expect(result).toBeDefined();
		expect(result).toContain("…(elided — fetch via `org get FEAT-601-inject-linked-child-org-bodies-into-appr`)");
		expect(result).not.toContain("\uFFFD");
	});
});
