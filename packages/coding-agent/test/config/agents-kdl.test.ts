import { describe, expect, it } from "bun:test";
import {
	type AgentRule,
	compileGlob,
	matchAgentRules,
	matchSelector,
	parseAgentSelector,
	parseAgentsBlock,
	selectorSpecificity,
} from "../../src/config/agents-kdl";

describe("compileGlob", () => {
	it("converts * to .*", () => {
		const re = compileGlob("foo*bar");
		expect(re.test("fooxbar")).toBe(true);
		expect(re.test("foobar")).toBe(true);
		expect(re.test("fooxxxbar")).toBe(true);
		expect(re.test("xfoobar")).toBe(false);
	});

	it("converts ? to .", () => {
		const re = compileGlob("foo?bar");
		expect(re.test("fooxbar")).toBe(true);
		expect(re.test("fooobar")).toBe(true);
		expect(re.test("fooxxbar")).toBe(false);
	});

	it("escapes regex metacharacters", () => {
		const re = compileGlob("foo.bar");
		expect(re.test("foo.bar")).toBe(true);
		expect(re.test("fooxbar")).toBe(false);
	});

	it("escapes multiple regex metacharacters", () => {
		const re = compileGlob("a+b(c)");
		expect(re.test("a+b(c)")).toBe(true);
		expect(re.test("ab(c)")).toBe(false);
		expect(re.test("aab(c)")).toBe(false);
	});

	it("anchors the pattern", () => {
		const re = compileGlob("test");
		expect(re.test("test")).toBe(true);
		expect(re.test("xtest")).toBe(false);
		expect(re.test("testx")).toBe(false);
	});
});

describe("parseAgentSelector", () => {
	it("parses exact selector", () => {
		const s = parseAgentSelector("reviewer");
		expect(s).toBeDefined();
		expect(s!.kind).toBe("exact");
		expect(s!.value).toBe("reviewer");
		expect(s!.pattern.test("reviewer")).toBe(true);
		expect(s!.pattern.test("xreviewer")).toBe(false);
	});

	it("parses prefixGlob selector (explore*)", () => {
		const s = parseAgentSelector("explore*");
		expect(s).toBeDefined();
		expect(s!.kind).toBe("prefixGlob");
		expect(s!.value).toBe("explore*");
		expect(s!.pattern.test("explore-x")).toBe(true);
		expect(s!.pattern.test("xexplore")).toBe(false);
	});

	it("parses suffixGlob selector (*-tester)", () => {
		const s = parseAgentSelector("*-tester");
		expect(s).toBeDefined();
		expect(s!.kind).toBe("suffixGlob");
		expect(s!.value).toBe("*-tester");
		expect(s!.pattern.test("foo-tester")).toBe(true);
		expect(s!.pattern.test("tester-foo")).toBe(false);
	});

	it("parses infixGlob selector (*explore*)", () => {
		const s = parseAgentSelector("*explore*");
		expect(s).toBeDefined();
		expect(s!.kind).toBe("infixGlob");
		expect(s!.value).toBe("*explore*");
		expect(s!.pattern.test("foo-explore-bar")).toBe(true);
		expect(s!.pattern.test("explore")).toBe(true);
	});

	it("parses wildcard selector (*)", () => {
		const s = parseAgentSelector("*");
		expect(s).toBeDefined();
		expect(s!.kind).toBe("wildcard");
		expect(s!.value).toBe("*");
		expect(s!.pattern.test("anything")).toBe(true);
		expect(s!.pattern.test("")).toBe(true);
	});

	it("returns undefined for empty string", () => {
		expect(parseAgentSelector("")).toBeUndefined();
	});

	it("returns undefined for whitespace-only string", () => {
		expect(parseAgentSelector("   ")).toBeUndefined();
		expect(parseAgentSelector("\t\n")).toBeUndefined();
	});

	it("parses infixGlob for middle-glob pattern (foo*bar)", () => {
		const s = parseAgentSelector("foo*bar");
		expect(s).toBeDefined();
		expect(s!.kind).toBe("infixGlob");
		expect(s!.pattern.test("fooxbar")).toBe(true);
		expect(s!.pattern.test("foobar")).toBe(true);
		expect(s!.pattern.test("foobaz")).toBe(false);
	});

	it("parses suffixGlob for ?-prefix pattern (?foo)", () => {
		const s = parseAgentSelector("?foo");
		expect(s).toBeDefined();
		expect(s!.kind).toBe("suffixGlob");
		expect(s!.pattern.test("afoo")).toBe(true);
		expect(s!.pattern.test("foo")).toBe(false);
	});

	it("escapes regex chars inside selector", () => {
		const s = parseAgentSelector("foo.bar*");
		expect(s).toBeDefined();
		expect(s!.kind).toBe("prefixGlob");
		expect(s!.pattern.test("foo.bar")).toBe(true);
		expect(s!.pattern.test("fooxbar")).toBe(false);
	});
});

describe("selectorSpecificity", () => {
	it("scores exact as 4", () => {
		const s = parseAgentSelector("reviewer")!;
		expect(selectorSpecificity(s)).toBe(4);
	});

	it("scores prefixGlob as 3", () => {
		const s = parseAgentSelector("explore*")!;
		expect(selectorSpecificity(s)).toBe(3);
	});

	it("scores suffixGlob as 2", () => {
		const s = parseAgentSelector("*-tester")!;
		expect(selectorSpecificity(s)).toBe(2);
	});

	it("scores infixGlob as 1", () => {
		const s = parseAgentSelector("*explore*")!;
		expect(selectorSpecificity(s)).toBe(1);
	});

	it("scores wildcard as 0", () => {
		const s = parseAgentSelector("*")!;
		expect(selectorSpecificity(s)).toBe(0);
	});
});

describe("matchSelector", () => {
	it("matches exact selector", () => {
		const s = parseAgentSelector("reviewer")!;
		expect(matchSelector("reviewer", s)).toBe(true);
		expect(matchSelector("Reviewer", s)).toBe(false);
		expect(matchSelector("xreviewer", s)).toBe(false);
	});

	it("matches prefix selector", () => {
		const s = parseAgentSelector("explore*")!;
		expect(matchSelector("explore-x", s)).toBe(true);
		expect(matchSelector("explore", s)).toBe(true);
		expect(matchSelector("xexplore", s)).toBe(false);
		expect(matchSelector("explorer", s)).toBe(true);
	});

	it("matches suffix selector", () => {
		const s = parseAgentSelector("*-tester")!;
		expect(matchSelector("foo-tester", s)).toBe(true);
		expect(matchSelector("tester", s)).toBe(false);
		expect(matchSelector("tester-foo", s)).toBe(false);
		expect(matchSelector("foo-tester-x", s)).toBe(false);
	});

	it("matches infix selector", () => {
		const s = parseAgentSelector("*explore*")!;
		expect(matchSelector("foo-explore-bar", s)).toBe(true);
		expect(matchSelector("explore", s)).toBe(true);
		expect(matchSelector("xexplore", s)).toBe(true);
		expect(matchSelector("explorex", s)).toBe(true);
		expect(matchSelector("ex-plore", s)).toBe(false);
	});

	it("wildcard always matches", () => {
		const s = parseAgentSelector("*")!;
		expect(matchSelector("anything", s)).toBe(true);
		expect(matchSelector("", s)).toBe(true);
		expect(matchSelector("foo-bar_baz", s)).toBe(true);
	});

	it("does not match when pattern differs", () => {
		const s = parseAgentSelector("foo?bar")!;
		expect(matchSelector("fooxbar", s)).toBe(true);
		expect(matchSelector("foobar", s)).toBe(false);
	});
});

describe("matchAgentRules", () => {
	const makeRule = (selector: string, order: number): AgentRule => ({
		selector: parseAgentSelector(selector)!,
		declarationOrder: order,
	});

	it("single rule match returns winning rule", () => {
		const rules = [makeRule("reviewer", 0)];
		const result = matchAgentRules("reviewer", rules);
		expect(result.winning).toBeDefined();
		expect(result.winning!.selector.value).toBe("reviewer");
		expect(result.conflicts).toHaveLength(0);
	});

	it("multiple rules with different specificity → most specific wins", () => {
		const rules = [makeRule("*", 0), makeRule("review*", 1), makeRule("reviewer", 2)];
		const result = matchAgentRules("reviewer", rules);
		expect(result.winning).toBeDefined();
		expect(result.winning!.selector.value).toBe("reviewer");
		expect(result.conflicts).toHaveLength(0);
	});

	it("same specificity tie → last-declared wins and conflict recorded", () => {
		const rules = [makeRule("reviewer", 0), makeRule("reviewer", 1)];
		const result = matchAgentRules("reviewer", rules);
		expect(result.winning).toBeDefined();
		expect(result.winning!.declarationOrder).toBe(1);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0].agentName).toBe("reviewer");
		expect(result.conflicts[0].selectors).toContain("reviewer");
	});

	it("wildcard catch-all when nothing else matches", () => {
		const rules = [makeRule("reviewer", 0), makeRule("*", 1)];
		const result = matchAgentRules("explorer", rules);
		expect(result.winning).toBeDefined();
		expect(result.winning!.selector.value).toBe("*");
		expect(result.conflicts).toHaveLength(0);
	});

	it("no rules → empty result", () => {
		const result = matchAgentRules("reviewer", []);
		expect(result.winning).toBeUndefined();
		expect(result.conflicts).toHaveLength(0);
	});

	it("agent name matching no selector → undefined winning", () => {
		const rules = [makeRule("reviewer", 0)];
		const result = matchAgentRules("explorer", rules);
		expect(result.winning).toBeUndefined();
		expect(result.conflicts).toHaveLength(0);
	});

	it("multiple same-specificity rules with different selectors → conflict recorded", () => {
		const rules = [makeRule("review*", 0), makeRule("rev*", 1)];
		const result = matchAgentRules("reviewer", rules);
		expect(result.winning).toBeDefined();
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0].selectors.sort()).toEqual(["rev*", "review*"]);
	});

	it("only highest-specificity matching rules are considered", () => {
		const rules = [makeRule("*", 0), makeRule("review*", 1), makeRule("explorer", 2)];
		const result = matchAgentRules("reviewer", rules);
		expect(result.winning).toBeDefined();
		expect(result.winning!.selector.value).toBe("review*");
		expect(result.conflicts).toHaveLength(0);
	});
});

describe("parseAgentsBlock", () => {
	it("returns empty config as placeholder", () => {
		const config = parseAgentsBlock({});
		expect(config.rules).toHaveLength(0);
		expect(config.conflicts).toHaveLength(0);
	});

	it("accepts sourcePath parameter", () => {
		const config = parseAgentsBlock({}, "/path/to/spell.kdl");
		expect(config.rules).toHaveLength(0);
		expect(config.conflicts).toHaveLength(0);
	});
});
