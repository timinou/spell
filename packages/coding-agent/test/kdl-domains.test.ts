/**
 * Declarative KDL domains: parsing, `extends` inheritance with field-kind-aware
 * merge, surface routing, and the activation env contract.
 */

import { describe, expect, it } from "bun:test";
import { parse } from "@bgotink/kdl";
import {
	mergeDomainDefs,
	type ParsedDomainBlock,
	parseDomainBlocks,
	resolveDomainExtends,
	resolveDomainManifests,
} from "../src/config/kdl-domains";
import { activateDomain } from "../src/domain/activation";
import type { SpellDomain } from "../src/domain/loader";
import { resolveStartupRoute } from "../src/domain/startup";

function parseDomains(kdl: string): ParsedDomainBlock[] {
	return parseDomainBlocks(parse(kdl));
}

describe("parseDomainBlocks", () => {
	it("parses a full declarative domain block", () => {
		const blocks = parseDomains(`
			domain "autonomous" {
				description "Auto"
				surface "none"
				knowledge { embeddings #false }
				tools { deny "ask" "canvas" }
				prompt "no human"
			}
		`);
		expect(blocks).toHaveLength(1);
		const b = blocks[0];
		expect(b.name).toBe("autonomous");
		expect(b.interactiveSurface).toBe("none");
		expect(b.knowledge).toEqual({ embeddings: false });
		expect(b.toolsDeny).toEqual(["ask", "canvas"]);
		expect(b.systemPrompt).toBe("no human");
	});

	it("parses knowledge embed-recency-days (BUG-477)", () => {
		const blocks = parseDomains(`
			domain "coding" {
				knowledge {
					embeddings #true
					embed-recency-days 90
				}
			}
		`);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].knowledge).toEqual({ embeddings: true, embedRecencyDays: 90 });
	});

	it("ignores zero / negative embed-recency-days", () => {
		const blocks = parseDomains(`
			domain "coding" {
				knowledge { embed-recency-days 0 }
			}
		`);
		// 0 disables the gate → not surfaced; knowledge has no other fields → undefined.
		expect(blocks[0].knowledge).toBeUndefined();
	});

	it('ignores a bare `domain "x"` selector (no children)', () => {
		// Selector form must NOT be parsed as a definition.
		expect(parseDomains(`domain "coding"`)).toHaveLength(0);
	});

	it("parses env require + set", () => {
		const [b] = parseDomains(`
			domain "harbor" {
				env {
					require "HARBOR_MODEL"
					set "PI_KNOWLEDGE_WORKER" "inprocess"
				}
			}
		`);
		expect(b.env?.require).toEqual(["HARBOR_MODEL"]);
		expect(b.env?.set).toEqual({ PI_KNOWLEDGE_WORKER: "inprocess" });
	});

	it("parses model roles and strict model resolution", () => {
		const [b] = parseDomains(`
			domain "harbor" {
				model {
					strict #true
					roles { default "$HARBOR_MODEL"; task "$HARBOR_MODEL" }
				}
			}
		`);
		expect(b.modelRoles).toEqual({ default: "$HARBOR_MODEL", task: "$HARBOR_MODEL" });
		expect(b.modelStrict).toBe(true);
	});
});

describe("mergeDomainDefs (field-kind-aware)", () => {
	const parent: ParsedDomainBlock = {
		name: "autonomous",
		interactiveSurface: "none",
		systemPrompt: "parent prompt",
		knowledge: { embeddings: false },
		toolsDeny: ["ask", "canvas", "browser"],
		modelRoles: { smol: "cheap" },
		env: { require: ["A"], set: { X: "1" } },
	};

	it("child scalars override parent", () => {
		const merged = mergeDomainDefs(parent, { name: "child", systemPrompt: "child prompt" });
		expect(merged.systemPrompt).toBe("child prompt");
		// unspecified scalars inherit
		expect(merged.interactiveSurface).toBe("none");
		expect(merged.knowledge).toEqual({ embeddings: false });
	});

	it("model roles deep-merge, child wins; strict inherits unless overridden", () => {
		const merged = mergeDomainDefs(
			{ ...parent, modelStrict: true },
			{
				name: "child",
				modelRoles: { default: "$HARBOR_MODEL", smol: "override" },
			},
		);
		expect(merged.modelRoles).toEqual({ smol: "override", default: "$HARBOR_MODEL" });
		expect(merged.modelStrict).toBe(true);

		const relaxed = mergeDomainDefs({ ...parent, modelStrict: true }, { name: "child", modelStrict: false });
		expect(relaxed.modelStrict).toBe(false);
	});

	it("env require unions, set merges", () => {
		const merged = mergeDomainDefs(parent, {
			name: "child",
			env: { require: ["B"], set: { Y: "2" } },
		});
		expect(merged.env?.require?.sort()).toEqual(["A", "B"]);
		expect(merged.env?.set).toEqual({ X: "1", Y: "2" });
	});

	it("tools deny unions; child allow subtracts from inherited deny", () => {
		// Child re-enables `browser` without re-listing the rest.
		const merged = mergeDomainDefs(parent, { name: "child", toolsAllow: ["browser"] });
		expect(new Set(merged.toolsDeny)).toEqual(new Set(["ask", "canvas"]));
		expect(merged.toolsAllow).toContain("browser");
	});
});

describe("resolveDomainExtends", () => {
	it("resolves a chain and fails loud on a missing parent", () => {
		const pool = new Map<string, ParsedDomainBlock>([
			["base", { name: "base", interactiveSurface: "none" }],
			["child", { name: "child", extends: "base" }],
		]);
		const resolved = resolveDomainExtends(pool.get("child")!, pool);
		expect(resolved.interactiveSurface).toBe("none");

		const orphan = new Map<string, ParsedDomainBlock>([["x", { name: "x", extends: "ghost" }]]);
		expect(() => resolveDomainExtends(orphan.get("x")!, orphan)).toThrow(/extends 'ghost'/);
	});

	it("detects a circular extends chain", () => {
		const pool = new Map<string, ParsedDomainBlock>([
			["a", { name: "a", extends: "b" }],
			["b", { name: "b", extends: "a" }],
		]);
		expect(() => resolveDomainExtends(pool.get("a")!, pool)).toThrow(/circular/);
	});
});

describe("resolveDomainManifests (end-to-end, harbor extends autonomous)", () => {
	const manifests = resolveDomainManifests(
		parseDomains(`
			domain "autonomous" {
				surface "none"
				knowledge { embeddings #false }
				tools { deny "ask" "canvas" "send_file" "approvals" "checkpoint" }
				prompt "no human"
			}
			domain "harbor" extends="autonomous" {
				env { require "HARBOR_MODEL"; set "PI_KNOWLEDGE_WORKER" "inprocess" }
				model { strict #true; roles { default "$HARBOR_MODEL"; task "$HARBOR_MODEL" } }
			}
		`),
	);

	it("harbor inherits autonomous surface/prompt/knowledge/tools", () => {
		const harbor = manifests.get("harbor")!;
		expect(harbor.interactiveSurface).toBe("none");
		expect(harbor.systemPrompt).toBe("no human");
		expect(harbor.knowledge).toEqual({ embeddings: false });
		expect(harbor.tools.exclude).toEqual(["ask", "canvas", "send_file", "approvals", "checkpoint"]);
	});

	it("harbor adds its own env + model roles", () => {
		const harbor = manifests.get("harbor")!;
		expect(harbor.env?.require).toEqual(["HARBOR_MODEL"]);
		expect(harbor.env?.set).toEqual({ PI_KNOWLEDGE_WORKER: "inprocess" });
		expect(harbor.modelRoles).toEqual({ default: "$HARBOR_MODEL", task: "$HARBOR_MODEL" });
		expect(harbor.modelStrict).toBe(true);
	});

	it("browser is NOT denied in the autonomous toolset", () => {
		const auto = manifests.get("autonomous")!;
		expect(auto.tools.exclude).not.toContain("browser");
	});
});

describe("resolveStartupRoute — surface none", () => {
	const noneDomain: SpellDomain = {
		name: "autonomous",
		description: "",
		tools: {},
		panels: [],
		workspaces: [],
		interactiveSurface: "none",
	};

	it("routes a surface:none domain to headless print", () => {
		const route = resolveStartupRoute({
			displayAvailable: true,
			domainManifest: noneDomain,
			hasPipedInput: false,
		});
		expect(route).toEqual({ kind: "print", mode: "text" });
	});

	it("explicit rpc mode still wins over surface none", () => {
		const route = resolveStartupRoute({
			displayAvailable: true,
			domainManifest: noneDomain,
			hasPipedInput: false,
			mode: "rpc",
		});
		expect(route.kind).toBe("rpc");
	});
});

describe("activateDomain — env contract", () => {
	const harbor: SpellDomain = {
		name: "harbor",
		description: "",
		tools: {},
		panels: [],
		workspaces: [],
		interactiveSurface: "none",
		knowledge: { embeddings: false },
		env: { require: ["HARBOR_MODEL"], set: { PI_KNOWLEDGE_WORKER: "inprocess" } },
		modelRoles: { default: "$HARBOR_MODEL", task: "$HARBOR_MODEL" },
	};

	it("fails loud when a required env var is missing", () => {
		expect(() => activateDomain(harbor, { env: {} })).toThrow(/HARBOR_MODEL/);
	});

	it("applies forced env, embeddings signal, and resolves model-role refs", () => {
		const setEnv: Record<string, string> = {};
		const roles: Record<string, string> = {};
		const result = activateDomain(harbor, {
			env: { HARBOR_MODEL: "anthropic/claude-x" },
			setEnv: (k, v) => {
				setEnv[k] = v;
			},
			settings: { overrideModelRoles: r => Object.assign(roles, r) },
		});
		expect(result.requiredOk).toBe(true);
		expect(setEnv.PI_KNOWLEDGE_WORKER_EMBEDDINGS).toBe("0");
		expect(setEnv.PI_KNOWLEDGE_WORKER).toBe("inprocess");
		// $HARBOR_MODEL refs resolved against env.
		expect(roles.default).toBe("anthropic/claude-x");
		expect(roles.task).toBe("anthropic/claude-x");
	});

	it("is a no-op for a domain with no contract", () => {
		const plain: SpellDomain = {
			name: "coding",
			description: "",
			tools: {},
			panels: [],
			workspaces: [],
		};
		const result = activateDomain(plain, { env: {} });
		expect(result).toEqual({ requiredOk: true, forcedEnv: [], pinnedRoles: [] });
	});
});
