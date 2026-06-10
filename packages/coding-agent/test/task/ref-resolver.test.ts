/**
 * ref-resolver unit tests (PLAN-327): shape dispatch + org gate mapping.
 */
import { describe, expect, test } from "bun:test";
import {
	buildOrgAssignment,
	buildOrgVerificationContext,
	mapOrgGateProperties,
	resolveRef,
} from "../../src/task/ref-resolver";

describe("resolveRef", () => {
	test("null/undefined/empty → none", () => {
		expect(resolveRef(null).kind).toBe("none");
		expect(resolveRef(undefined).kind).toBe("none");
		expect(resolveRef("").kind).toBe("none");
		expect(resolveRef("   ").kind).toBe("none");
	});

	test("roster id → roster", () => {
		const r = resolveRef("task-3");
		expect(r.kind).toBe("roster");
		if (r.kind === "roster") expect(r.id).toBe("task-3");
	});

	test("org:// uri → org with item id", () => {
		const r = resolveRef("org://FEAT-123");
		expect(r.kind).toBe("org");
		if (r.kind === "org") {
			expect(r.itemId).toBe("FEAT-123");
			expect(r.uri).toBe("org://FEAT-123");
		}
	});

	test("org:// with trailing slashes strips them", () => {
		const r = resolveRef("org://PLAN-9//");
		expect(r.kind).toBe("org");
		if (r.kind === "org") expect(r.itemId).toBe("PLAN-9");
	});

	test("org:// with empty id → none", () => {
		expect(resolveRef("org://").kind).toBe("none");
	});

	test("id starting with 'org' but not 'org://' is a roster id", () => {
		const r = resolveRef("organize-3");
		expect(r.kind).toBe("roster");
	});
});

describe("buildOrgVerificationContext", () => {
	test("maps the full gate property set", () => {
		const text = buildOrgVerificationContext({
			itemId: "FEAT-1",
			title: "T",
			state: "ITEM",
			body: "",
			verificationLines: [
				"You MUST run: `bun test` and verify it passes.",
				"You MUST self-review against: no console.log",
			],
		});
		expect(text).toContain("Verification Requirements (from org://FEAT-1)");
		expect(text).toContain("bun test");
		expect(text).toContain("self-review");
	});

	test("returns undefined when no gate lines", () => {
		expect(
			buildOrgVerificationContext({ itemId: "X", title: "T", state: "ITEM", body: "", verificationLines: [] }),
		).toBeUndefined();
	});
});

describe("mapOrgGateProperties (wave-1 parity)", () => {
	test("maps the full gate set incl gateLlm/verificationArtifact/orgItemClosingId", () => {
		const lines = mapOrgGateProperties({
			GATE_CMD: "bun test",
			GATE_ARTIFACT: "out.txt",
			VERIFICATION_ARTIFACT: "evidence.md",
			GATE_COMMIT: "true",
			GATE_LLM: "no console.log",
			VERIFY_CMD: "bun lint",
			ORG_ITEM_CLOSING_ID: "FEAT-9",
		});
		const joined = lines.join("\n");
		expect(joined).toContain("bun test");
		expect(joined).toContain("out.txt");
		expect(joined).toContain("evidence.md");
		expect(joined).toContain("commit changes");
		expect(joined).toContain("self-review against: no console.log");
		expect(joined).toContain("bun lint");
		expect(joined).toContain("FEAT-9");
	});

	test("dual-spelling: lower_snake keys resolve", () => {
		const lines = mapOrgGateProperties({ gate_cmd: "make test", gate_llm: "tidy" });
		const joined = lines.join("\n");
		expect(joined).toContain("make test");
		expect(joined).toContain("tidy");
	});

	test("gateCommit falsy tokens (false/0/no/off) do NOT inject commit line", () => {
		for (const v of ["false", "0", "no", "off", "FALSE", "Off"]) {
			const lines = mapOrgGateProperties({ GATE_COMMIT: v });
			expect(lines.join("\n")).not.toContain("commit changes");
		}
	});

	test("gateCommit truthy injects commit line", () => {
		expect(mapOrgGateProperties({ GATE_COMMIT: "true" }).join("\n")).toContain("commit changes");
		expect(mapOrgGateProperties({ GATE_COMMIT: "yes" }).join("\n")).toContain("commit changes");
	});

	test("empty properties → no lines", () => {
		expect(mapOrgGateProperties({})).toEqual([]);
	});
});

describe("buildOrgAssignment", () => {
	test("title + body", () => {
		const a = buildOrgAssignment({ itemId: "X", title: "Do thing", state: "ITEM", body: "details here", verificationLines: [] });
		expect(a).toContain("## Task: Do thing");
		expect(a).toContain("details here");
	});

	test("empty body → title only", () => {
		const a = buildOrgAssignment({ itemId: "X", title: "Do thing", state: "ITEM", body: "", verificationLines: [] });
		expect(a).toBe("## Task: Do thing");
	});
});
