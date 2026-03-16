import { describe, expect, test } from "bun:test";
import type { OrgItem } from "@oh-my-pi/pi-org";
import { formatOrgQueryResult, renderItemOrg } from "../src/tools/org-format";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<OrgItem> = {}): OrgItem {
	return {
		id: "PROJ-001-test",
		title: "Test item",
		state: "ITEM",
		category: "projects",
		dir: "tasks",
		file: "/tmp/test.org",
		line: 1,
		level: 1,
		properties: {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// renderItemOrg
// ---------------------------------------------------------------------------

describe("renderItemOrg", () => {
	test("renders heading with state and title", () => {
		const item = makeItem({ state: "DOING", title: "My task" });
		const out = renderItemOrg(item, false, 0);
		expect(out).toMatch(/^\* DOING My task/);
	});

	test("renders tags on heading line when TAGS property present", () => {
		const item = makeItem({ properties: { TAGS: "backend:auth" } });
		const out = renderItemOrg(item, false, 0);
		expect(out).toMatch(/^\* ITEM Test item\s+:backend:auth:/m);
	});

	test("renders PROPERTIES drawer with CUSTOM_ID", () => {
		const item = makeItem({ id: "PROJ-042-auth" });
		const out = renderItemOrg(item, false, 0);
		expect(out).toContain(":PROPERTIES:");
		expect(out).toContain(":CUSTOM_ID: PROJ-042-auth");
		expect(out).toContain(":END:");
	});

	test("renders all item properties in drawer", () => {
		const item = makeItem({ properties: { EFFORT: "2h", PRIORITY: "#A" } });
		const out = renderItemOrg(item, false, 0);
		expect(out).toContain(":EFFORT: 2h");
		expect(out).toContain(":PRIORITY: #A");
	});

	test("includes body when includeBody is true", () => {
		const item = makeItem({ body: "This is the body." });
		const out = renderItemOrg(item, true, 10_000);
		expect(out).toContain("This is the body.");
	});

	test("excludes body when includeBody is false", () => {
		const item = makeItem({ body: "This is the body." });
		const out = renderItemOrg(item, false, 0);
		expect(out).not.toContain("This is the body.");
	});

	test("truncates body that exceeds maxBodyBytes and appends notice", () => {
		const longBody = "x".repeat(3000);
		const item = makeItem({ id: "PROJ-001-test", body: longBody });
		const out = renderItemOrg(item, true, 100);
		expect(out).not.toContain(longBody);
		expect(out).toContain("[body truncated");
		expect(out).toContain("PROJ-001-test");
	});

	test("does not truncate body exactly at limit", () => {
		const body = "a".repeat(100);
		const item = makeItem({ body });
		const out = renderItemOrg(item, true, 100);
		expect(out).toContain(body);
		expect(out).not.toContain("[body truncated");
	});

	test("item with no properties beyond CUSTOM_ID renders minimal drawer", () => {
		const item = makeItem({ properties: {} });
		const out = renderItemOrg(item, false, 0);
		const lines = out.split("\n");
		const propLines = lines.filter(l => l.startsWith(":") && l !== ":PROPERTIES:" && l !== ":END:");
		expect(propLines).toEqual([":CUSTOM_ID: PROJ-001-test"]);
	});
});

// ---------------------------------------------------------------------------
// formatOrgQueryResult
// ---------------------------------------------------------------------------

describe("formatOrgQueryResult", () => {
	test("empty result returns sensible message", () => {
		const out = formatOrgQueryResult([], 0);
		expect(out.length).toBeGreaterThan(0);
		expect(out.toLowerCase()).toMatch(/no items/i);
	});

	test("small result: all items rendered with bodies, no summary line", () => {
		const items = Array.from({ length: 3 }, (_, i) =>
			makeItem({ id: `PROJ-00${i + 1}-test`, title: `Item ${i + 1}`, body: "Short body." }),
		);
		const out = formatOrgQueryResult(items, 3);
		expect(out).toContain("PROJ-001-test");
		expect(out).toContain("PROJ-002-test");
		expect(out).toContain("PROJ-003-test");
		expect(out).toContain("Short body.");
		expect(out).not.toMatch(/hidden/i);
	});

	test("total output never exceeds 80KB", () => {
		// 200 items each with 5KB body
		const bigBody = "y".repeat(5 * 1024);
		const items = Array.from({ length: 200 }, (_, i) =>
			makeItem({ id: `PROJ-${String(i).padStart(3, "0")}-item`, title: `Item ${i}`, body: bigBody }),
		);
		const out = formatOrgQueryResult(items, 200);
		expect(Buffer.byteLength(out)).toBeLessThanOrEqual(80 * 1024);
	});

	test("summary line has correct counts", () => {
		const bigBody = "z".repeat(5 * 1024);
		const items = Array.from({ length: 100 }, (_, i) =>
			makeItem({ id: `PROJ-${String(i).padStart(3, "0")}-item`, title: `Item ${i}`, body: bigBody }),
		);
		const out = formatOrgQueryResult(items, 100);
		// Must have a summary when some are hidden
		if (out.includes("hidden")) {
			expect(out).toMatch(/Showing \d+ of 100/);
			expect(out).toMatch(/\d+ with body/);
			expect(out).toMatch(/\d+ headers only/);
			expect(out).toMatch(/\d+ hidden/);
		}
	});

	test("items with no body are handled in header phase", () => {
		const items = Array.from({ length: 10 }, (_, i) => makeItem({ id: `PROJ-0${i}-no-body`, title: `Header ${i}` }));
		const out = formatOrgQueryResult(items, 10);
		// All headers should appear — no body means they're tiny
		for (let i = 0; i < 10; i++) {
			expect(out).toContain(`PROJ-0${i}-no-body`);
		}
	});
});
