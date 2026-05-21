/**
 * Parser tests for swarm definitions.
 *
 * The swarm extension supports two input formats:
 *   - KDL (canonical, PLAN-311 WAVE 2b)
 *   - YAML (legacy; kept for one release as deprecated)
 *
 * `parseSwarm()` auto-detects the format from the first non-blank line.
 */

import { describe, expect, it } from "bun:test";
import { parseSwarm, parseSwarmKdl, parseSwarmYaml, validateSwarmDefinition } from "./schema";

describe("parseSwarmKdl", () => {
	it("parses a canonical KDL swarm definition", () => {
		const kdl = `
swarm "demo" workspace="." mode="sequential" target-count=1 model="claude-sonnet" {
  agent "researcher" model="claude-sonnet" {
    role "Investigate"
    task "Find all uses of foo"
    extra-context "Focus on src/"
  }
  agent "writer" {
    role "Synthesise"
    task "Produce a report"
    reports-to "researcher"
  }
}`;
		const def = parseSwarmKdl(kdl);
		expect(def.name).toBe("demo");
		expect(def.workspace).toBe(".");
		expect(def.mode).toBe("sequential");
		expect(def.targetCount).toBe(1);
		expect(def.model).toBe("claude-sonnet");
		expect(def.agentOrder).toEqual(["researcher", "writer"]);

		const researcher = def.agents.get("researcher");
		expect(researcher?.role).toBe("Investigate");
		expect(researcher?.task).toBe("Find all uses of foo");
		expect(researcher?.extraContext).toBe("Focus on src/");
		expect(researcher?.model).toBe("claude-sonnet");
		expect(researcher?.reportsTo).toEqual([]);

		const writer = def.agents.get("writer");
		expect(writer?.reportsTo).toEqual(["researcher"]);
	});

	it("accepts swarm name as property (`name=...`) instead of argument", () => {
		const def = parseSwarmKdl(`swarm name="from-prop" workspace="." {
  agent "a" { role "r"; task "t" }
}`);
		expect(def.name).toBe("from-prop");
	});

	it("rejects swarm without name", () => {
		expect(() =>
			parseSwarmKdl(`swarm workspace="." {
  agent "a" { role "r"; task "t" }
}`),
		).toThrow(/name is required/);
	});

	it("rejects invalid swarm name", () => {
		expect(() =>
			parseSwarmKdl(`swarm "bad name!" workspace="." {
  agent "a" { role "r"; task "t" }
}`),
		).toThrow(/letters, numbers, dot, underscore, and dash/);
	});

	it("rejects missing workspace", () => {
		expect(() =>
			parseSwarmKdl(`swarm "x" {
  agent "a" { role "r"; task "t" }
}`),
		).toThrow(/workspace is required/);
	});

	it("rejects invalid mode", () => {
		expect(() =>
			parseSwarmKdl(`swarm "x" workspace="." mode="invalid" {
  agent "a" { role "r"; task "t" }
}`),
		).toThrow(/Invalid mode/);
	});

	it("rejects swarm with zero agents", () => {
		expect(() => parseSwarmKdl(`swarm "x" workspace="." {}`)).toThrow(/at least one agent/);
	});

	it("rejects agent missing role", () => {
		expect(() =>
			parseSwarmKdl(`swarm "x" workspace="." {
  agent "a" { task "t" }
}`),
		).toThrow(/'role' is required/);
	});

	it("rejects agent missing task", () => {
		expect(() =>
			parseSwarmKdl(`swarm "x" workspace="." {
  agent "a" { role "r" }
}`),
		).toThrow(/'task' is required/);
	});

	it("multi-value waits-for resolves as array", () => {
		const def = parseSwarmKdl(`swarm "x" workspace="." {
  agent "data-prep" { role "r"; task "t" }
  agent "init" { role "r"; task "t" }
  agent "main" {
    role "r"
    task "t"
    waits-for "data-prep" "init"
  }
}`);
		expect(def.agents.get("main")?.waitsFor).toEqual(["data-prep", "init"]);
	});

	it("targetCount defaults to 1 when omitted", () => {
		const def = parseSwarmKdl(`swarm "x" workspace="." {
  agent "a" { role "r"; task "t" }
}`);
		expect(def.targetCount).toBe(1);
	});

	it("parses pipeline mode with target-count > 1", () => {
		const def = parseSwarmKdl(`swarm "x" workspace="." mode="pipeline" target-count=3 {
  agent "a" { role "r"; task "t" }
}`);
		expect(def.mode).toBe("pipeline");
		expect(def.targetCount).toBe(3);
	});
});

describe("parseSwarm: format auto-detection", () => {
	it("KDL content dispatches to parseSwarmKdl", () => {
		const kdl = `swarm "k" workspace="." {
  agent "a" { role "r"; task "t" }
}`;
		const def = parseSwarm(kdl);
		expect(def.name).toBe("k");
	});

	it("YAML content dispatches to parseSwarmYaml", () => {
		const yaml = `swarm:
  name: y
  workspace: "."
  agents:
    a:
      role: r
      task: t
`;
		const def = parseSwarm(yaml);
		expect(def.name).toBe("y");
	});
});

describe("backwards compat: parseSwarmYaml still works", () => {
	it("legacy YAML still parses without invoking the new dispatcher", () => {
		const yaml = `swarm:
  name: legacy
  workspace: "."
  mode: parallel
  agents:
    a:
      role: r
      task: t
`;
		const def = parseSwarmYaml(yaml);
		expect(def.name).toBe("legacy");
		expect(def.mode).toBe("parallel");
	});
});

describe("GATE 2b regressions", () => {
	it("[P2.1] duplicate KDL agent names rejected at parse", () => {
		expect(() =>
			parseSwarmKdl(`swarm "x" workspace="." {
  agent "dup" { role "r"; task "t" }
  agent "dup" { role "r2"; task "t2" }
}`),
		).toThrow(/duplicated/);
	});

	it("[P3] KDL files with leading // line comments correctly classified", () => {
		const kdl = `// swarm for the demo
swarm "k" workspace="." {
  agent "a" { role "r"; task "t" }
}`;
		const def = parseSwarm(kdl);
		expect(def.name).toBe("k");
	});

	it("[P3] KDL files with leading /* block */ comments correctly classified", () => {
		const kdl = `/* big
   multi-line
   comment */
swarm "k" workspace="." {
  agent "a" { role "r"; task "t" }
}`;
		const def = parseSwarm(kdl);
		expect(def.name).toBe("k");
	});

	it("[P3] YAML files with leading # comments still classified as YAML", () => {
		const yaml = `# my swarm definition
swarm:
  name: y
  workspace: "."
  agents:
    a:
      role: r
      task: t
`;
		const def = parseSwarm(yaml);
		expect(def.name).toBe("y");
	});
});

describe("validation: applies regardless of source format", () => {
	it("KDL-parsed definitions go through validateSwarmDefinition", () => {
		const def = parseSwarmKdl(`swarm "x" workspace="." {
  agent "a" {
    role "r"
    task "t"
    waits-for "nonexistent"
  }
}`);
		const errs = validateSwarmDefinition(def);
		expect(errs.some(e => e.includes("nonexistent"))).toBe(true);
	});
});
