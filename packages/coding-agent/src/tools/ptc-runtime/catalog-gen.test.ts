/**
 * Unit tests for catalog codegen: TypeBox schema → PTC signature, effect tags,
 * provider aliases. Pure functions, no BEAM.
 */

import { describe, expect, it } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
	type CatalogModel,
	type CatalogTool,
	generateCatalog,
	generateProviderCatalog,
	generateToolCatalog,
	ptcType,
	schemaToSignature,
} from "./catalog-gen";
import { effectOf } from "./effects";

describe("ptcType", () => {
	it("maps scalars", () => {
		expect(ptcType({ type: "string" })).toBe(":string");
		expect(ptcType({ type: "integer" })).toBe(":int");
		expect(ptcType({ type: "number" })).toBe(":float");
		expect(ptcType({ type: "boolean" })).toBe(":bool");
	});

	it("maps arrays recursively", () => {
		expect(ptcType({ type: "array", items: { type: "string" } })).toBe("[:string]");
		expect(ptcType({ type: "array", items: { type: "array", items: { type: "integer" } } })).toBe("[[:int]]");
	});

	it("maps objects to :map", () => {
		expect(ptcType({ type: "object", properties: {} })).toBe(":map");
		expect(ptcType({ type: "object", patternProperties: { "^(.*)$": {} } })).toBe(":map");
	});

	it("degrades unions/enums/unknown to :any (never throws)", () => {
		expect(ptcType({ anyOf: [{ const: "x" }, { const: "y" }] })).toBe(":any");
		expect(ptcType({ enum: [1, 2, 3] })).toBe(":any");
		expect(ptcType(undefined)).toBe(":any");
		expect(ptcType({} as never)).toBe(":any");
	});

	it("follows allOf to first concrete branch", () => {
		expect(ptcType({ allOf: [{ type: "string" }] })).toBe(":string");
	});
});

describe("schemaToSignature", () => {
	it("renders required and optional fields", () => {
		const schema = Type.Object({
			target: Type.String(),
			content: Type.Optional(Type.Boolean()),
		});
		expect(schemaToSignature(schema)).toBe("(target :string, content :bool?) -> :any");
	});

	it("handles array + object fields", () => {
		const schema = Type.Object({
			items: Type.Array(Type.String()),
			opts: Type.Optional(Type.Record(Type.String(), Type.Any())),
		});
		expect(schemaToSignature(schema)).toBe("(items [:string], opts :map?) -> :any");
	});

	it("renders an OPTIONAL array as :any? (the grammar has no optional list form)", () => {
		// ptc_runner rejects `[:t]?` — verified empirically (Review Gate 2, P1).
		const schema = Type.Object({ tasks: Type.Optional(Type.Array(Type.String())) });
		expect(schemaToSignature(schema)).toBe("(tasks :any?) -> :any");
	});

	it("keeps a REQUIRED array as [:t]", () => {
		const schema = Type.Object({ tasks: Type.Array(Type.String()) });
		expect(schemaToSignature(schema)).toBe("(tasks [:string]) -> :any");
	});

	it("returns nullary signature for absent/non-object schemas", () => {
		expect(schemaToSignature(undefined)).toBe("() -> :any");
		expect(schemaToSignature(Type.String())).toBe("() -> :any");
	});
});

describe("generateToolCatalog", () => {
	const tools: CatalogTool[] = [
		{ name: "find", description: "Find tool\nmore", parameters: Type.Object({ target: Type.String() }) },
		{ name: "calc", parameters: Type.Object({ expr: Type.String() }) },
		{ name: "bash", parameters: Type.Object({ command: Type.String() }) },
	];

	it("sorts by name and attaches signature + effect", () => {
		const cat = generateToolCatalog(tools);
		expect(cat.map(c => c.name)).toEqual(["bash", "calc", "find"]);
		const find = cat.find(c => c.name === "find")!;
		expect(find.signature).toBe("(target :string) -> :any");
		expect(find.effect).toBe("read");
		expect(find.description).toBe("Find tool");
		expect(cat.find(c => c.name === "bash")!.effect).toBe("exec");
		expect(cat.find(c => c.name === "calc")!.effect).toBe("pure");
	});

	it("defaults unknown tools to exec effect", () => {
		const cat = generateToolCatalog([{ name: "mystery_tool" }]);
		expect(cat[0].effect).toBe("exec");
		expect(cat[0].signature).toBe("() -> :any");
	});
});

describe("effectOf", () => {
	it("tags known tools and defaults unknown to exec", () => {
		expect(effectOf("find")).toBe("read");
		expect(effectOf("edit")).toBe("write");
		expect(effectOf("bash")).toBe("exec");
		expect(effectOf("fetch")).toBe("network");
		expect(effectOf("calc")).toBe("pure");
		expect(effectOf("memory")).toBe("write"); // note/save/link mutate — tagged at max
		expect(effectOf("totally_unknown")).toBe("exec");
	});
});

describe("generateProviderCatalog", () => {
	const models: CatalogModel[] = [
		{ id: "haiku", provider: "anthropic", cost: { input: 1, output: 5 } },
		{ id: "sonnet", provider: "anthropic", cost: { input: 3, output: 15 } },
		{ id: "opus", provider: "anthropic", cost: { input: 15, output: 75 } },
	];

	it("emits semantic aliases by cost", () => {
		const cat = generateProviderCatalog(models);
		const byAlias = new Map(cat.map(c => [c.alias, c.model]));
		expect(byAlias.get("cheap")).toBe("anthropic/haiku");
		expect(byAlias.get("fast")).toBe("anthropic/haiku");
		expect(byAlias.get("smart")).toBe("anthropic/opus");
	});

	it("emits every model under its fully-qualified id", () => {
		const cat = generateProviderCatalog(models);
		const aliases = cat.map(c => c.alias);
		expect(aliases).toContain("anthropic/haiku");
		expect(aliases).toContain("anthropic/sonnet");
		expect(aliases).toContain("anthropic/opus");
	});

	it("handles an empty model set", () => {
		expect(generateProviderCatalog([])).toEqual([]);
	});
});

describe("generateCatalog", () => {
	it("assembles tools + providers", () => {
		const cat = generateCatalog(
			[{ name: "find", parameters: Type.Object({ target: Type.String() }) }],
			[{ id: "haiku", provider: "anthropic", cost: { input: 1, output: 5 } }],
		);
		expect(cat.tools).toHaveLength(1);
		expect(cat.providers.length).toBeGreaterThan(0);
	});
});
