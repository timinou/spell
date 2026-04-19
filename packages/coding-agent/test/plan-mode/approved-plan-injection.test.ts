import { describe, expect, test } from "bun:test";
import { renderPromptTemplate } from "../../src/config/prompt-templates";
import { buildChildItemSpecs, renderChildItemSpec } from "../../src/plan-mode/child-item-spec";
import planModeApprovedPrompt from "../../src/prompts/system/plan-mode-approved.md" with { type: "text" };

function renderChildSpecs(context: {
	childItems?: Array<Parameters<typeof renderChildItemSpec>[0]>;
	omittedCount?: number;
	totalCount?: number;
}): string {
	const preparedChildItems = context.childItems?.map(renderChildItemSpec);
	return renderPromptTemplate(planModeApprovedPrompt, {
		childItems: preparedChildItems?.length ? preparedChildItems : undefined,
		omittedCount: context.omittedCount ?? 0,
		totalCount: context.totalCount ?? preparedChildItems?.length ?? 0,
		planContent: "1. Do work",
		finalPlanFilePath: "org://PLAN-272-test",
		orgItemId: "PLAN-272-test",
		orgItemArtifactsDir: "!tasks/plans/plan-artifacts/PLAN-272-test",
	});
}

describe("approved plan child item injection", () => {
	test("renders ordered child item specifications before the plan", () => {
		const rendered = renderChildSpecs({
			childItems: [
				{ id: "FEAT-A", title: "Foo", body: "body-a", properties: { LAYER: "core" } },
				{ id: "FEAT-B", title: "Bar", body: "body-b", properties: { LAYER: "ui" } },
			],
			totalCount: 2,
		});

		expect(rendered).toContain("## Child Item Specifications");
		expect(rendered).toContain("### FEAT-A - Foo");
		expect(rendered).toContain("### FEAT-B - Bar");
		expect(rendered).toContain("body-a");
		expect(rendered).toContain("body-b");
		expect(rendered).toContain("- Properties: LAYER=core");
		expect(rendered).toContain("- Properties: LAYER=ui");
		expect(rendered.indexOf("### FEAT-A - Foo")).toBeLessThan(rendered.indexOf("### FEAT-B - Bar"));
		expect(rendered.indexOf("## Child Item Specifications")).toBeLessThan(rendered.indexOf("## Plan"));
	});

	test("sorts properties alphabetically and renders values verbatim", () => {
		const rendered = renderChildSpecs({
			childItems: [
				{
					id: "FEAT-A",
					body: "body-a",
					properties: { ZETA: "keep=verbatim", ALPHA: "first" },
				},
			],
			totalCount: 1,
		});

		expect(rendered).toContain("- Properties: ALPHA=first, ZETA=keep=verbatim");
	});

	test("emits a per-child truncation marker when a child body exceeds the byte cap", () => {
		const longBody = `* Scope\n\n${"x".repeat(12_000)}`;
		const specs = buildChildItemSpecs(
			new Map([["FEAT-A", { id: "FEAT-A", file: "feat-a.org", body: longBody, properties: { LAYER: "core" } }]]),
			["FEAT-A"],
			{ perChildMaxBytes: 8192, globalMaxBytes: 100_000 },
		);
		const rendered = renderChildSpecs({ childItems: specs.items, totalCount: specs.totalCount });
		const truncatedBody = specs.items[0]?.body ?? "";

		expect(Buffer.byteLength(truncatedBody, "utf8")).toBeLessThanOrEqual(8192);
		expect(rendered).toContain("…(elided — fetch via `org get FEAT-A`)");
	});

	test("omits the section when child items are absent or empty", () => {
		expect(renderChildSpecs({})).not.toContain("## Child Item Specifications");
		expect(renderChildSpecs({ childItems: [], totalCount: 0 })).not.toContain("## Child Item Specifications");
	});

	test("preserves UTF-8 validity when truncation lands inside a multibyte code point", () => {
		const longEmojiBody = `* Scope\n\n${"🙂".repeat(3_000)}`;
		const specs = buildChildItemSpecs(
			new Map([
				[
					"FEAT-UTF8",
					{ id: "FEAT-UTF8", file: "feat-utf8.org", body: longEmojiBody, properties: { LAYER: "core" } },
				],
			]),
			["FEAT-UTF8"],
			{ perChildMaxBytes: 8_193, globalMaxBytes: 100_000 },
		);
		const rendered = renderChildSpecs({ childItems: specs.items, totalCount: specs.totalCount });
		const body = specs.items[0]?.body ?? "";

		expect(body).not.toContain("\uFFFD");
		expect(rendered).toContain("…(elided — fetch via `org get FEAT-UTF8`)");
	});

	test("drops whole trailing child specs when the global budget is exceeded", () => {
		const resolvedChildren = new Map(
			["FEAT-A", "FEAT-B", "FEAT-C"].map(id => [
				id,
				{ id, file: `${id}.org`, body: `* Scope\n\n${id}-${"x".repeat(6_000)}`, properties: { LAYER: "core" } },
			]),
		);
		const specs = buildChildItemSpecs(resolvedChildren, ["FEAT-A", "FEAT-B", "FEAT-C"], {
			perChildMaxBytes: 10_000,
			globalMaxBytes: 10_000,
		});
		const rendered = renderChildSpecs({
			childItems: specs.items,
			omittedCount: specs.omittedCount,
			totalCount: specs.totalCount,
		});

		expect(specs.items).toHaveLength(1);
		expect(rendered).toContain("### FEAT-A - Scope");
		expect(rendered).not.toContain("### FEAT-B - Scope");
		expect(rendered).toContain("…(2 of 3 child specifications omitted — fetch via `org get`)");
	});

	test("renders empty-body child specs without a truncation marker", () => {
		const rendered = renderChildSpecs({
			childItems: [{ id: "FEAT-EMPTY", title: "Empty", body: "", properties: { LAYER: "core" } }],
			totalCount: 1,
		});

		expect(rendered).toContain("### FEAT-EMPTY - Empty");
		expect(rendered).toContain("- Properties: LAYER=core");
		expect(rendered).not.toContain("…(elided — fetch via `org get FEAT-EMPTY`)");
	});
});
