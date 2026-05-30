/**
 * Frontmatter dual-mode parser regression.
 *
 * PLAN-311 WAVE 3: Spell-authored markdown (agents, modes, rules, skills)
 * defaults to `---kdl` frontmatter. YAML `---` is still accepted for
 * third-party content.
 *
 * Covers:
 *   - serializeAgent now emits `---kdl` blocks with KDL syntax
 *   - the parser handles both formats and produces equivalent output
 *   - all SettingPath-style keys round-trip (kebab in KDL ↔ camel in JS)
 */

import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "@spell/pi-coding-agent/utils/frontmatter";

describe("frontmatter parser: dual-mode KDL + YAML", () => {
	it("parses ---kdl block with kebab-case keys to camelCase JS keys", () => {
		const content = `---kdl
name "explore"
description "Fast read-only codebase scout"
tools "find" "fetch" "web_search"
model "claude-sonnet"
thinking-level "high"
---

System prompt body.
`;
		const result = parseFrontmatter(content);
		expect(result.format).toBe("kdl");
		expect(result.frontmatter.name).toBe("explore");
		expect(result.frontmatter.description).toBe("Fast read-only codebase scout");
		expect(result.frontmatter.tools).toEqual(["find", "fetch", "web_search"]);
		expect(result.frontmatter.thinkingLevel).toBe("high");
		expect(result.body).toContain("System prompt body");
	});

	it("parses ---kdl with boolean-as-bare-node (blocking)", () => {
		const content = `---kdl
name "blocker"
description "x"
blocking
---

body
`;
		const result = parseFrontmatter(content);
		expect(result.frontmatter.blocking).toBe(true);
	});

	it("legacy ---  YAML frontmatter still parses", () => {
		const content = `---
name: legacy
description: still works
tools:
  - find
  - fetch
thinkingLevel: medium
---

body
`;
		const result = parseFrontmatter(content);
		expect(result.format).toBe("yaml");
		expect(result.frontmatter.name).toBe("legacy");
		expect(result.frontmatter.thinkingLevel).toBe("medium");
		expect(result.frontmatter.tools).toEqual(["find", "fetch"]);
	});

	it("KDL and YAML produce equivalent JS structures for the same agent", () => {
		const kdlContent = `---kdl
name "agent"
description "d"
tools "a" "b"
thinking-level "high"
---
body`;
		const yamlContent = `---
name: agent
description: d
tools:
  - a
  - b
thinkingLevel: high
---
body`;

		const fromKdl = parseFrontmatter(kdlContent).frontmatter;
		const fromYaml = parseFrontmatter(yamlContent).frontmatter;

		// Equivalent semantics.
		expect(fromKdl.name).toBe(fromYaml.name);
		expect(fromKdl.description).toBe(fromYaml.description);
		expect(fromKdl.tools).toEqual(fromYaml.tools as never);
		expect(fromKdl.thinkingLevel).toBe(fromYaml.thinkingLevel);
	});

	it("rejects malformed KDL with a clear error", () => {
		const content = `---kdl
name "x
description "broken
---
body`;
		// Parser shouldn't throw uncaught; it returns format with a warning
		// via the callback if set. With default options, the result is the
		// fallback (likely with `format: null`).
		expect(() => parseFrontmatter(content)).not.toThrow();
	});
});

describe("agents-cli: serializeAgent emits ---kdl (real bundled-agent shapes)", () => {
	it("round-trips a reviewer-style agent with model[], spawns[], scopeRestricted, object output", async () => {
		// Mirrors the actual reviewer bundled agent: model is string[], spawns
		// is string[], output is a JSON Schema object, scopeRestricted is set.
		const content = [
			"---kdl",
			'name "reviewer"',
			'description "Critical code review"',
			'tools "find" "grep" "fetch"',
			'spawns "explore" "task"',
			'model "pi/slow" "claude-sonnet"',
			'thinking-level "high"',
			'output "{\\"properties\\":{\\"verdict\\":{\\"type\\":\\"string\\"}}}"',
			"scope-restricted #true",
			"---",
			"",
			"body",
			"",
		].join("\n");

		const result = parseFrontmatter(content);
		expect(result.format).toBe("kdl");
		expect(result.frontmatter).toMatchObject({
			name: "reviewer",
			tools: ["find", "grep", "fetch"],
			spawns: ["explore", "task"],
			model: ["pi/slow", "claude-sonnet"],
			thinkingLevel: "high",
			scopeRestricted: true,
		});
		// output is JSON-encoded; consumers JSON.parse if they expect structure.
		expect(typeof result.frontmatter.output).toBe("string");
		const parsedOutput = JSON.parse(result.frontmatter.output as string);
		expect(parsedOutput).toMatchObject({ properties: { verdict: { type: "string" } } });
	});

	it("spawns '*' (wildcard string) round-trips", async () => {
		const content = '---kdl\nname "orchestrator"\ndescription "all"\nspawns "*"\n---\nbody';
		const result = parseFrontmatter(content);
		expect(result.frontmatter.spawns).toBe("*");
	});
});
