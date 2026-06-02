/**
 * Catalog codegen — Spell's single source of truth → the PtcRuntime `init`
 * payload.
 *
 * The runtime is hydrated at boot with a catalog describing the tools a program
 * may call and the provider aliases it may target. Rather than hand-maintain a
 * second list, this module DERIVES the catalog from Spell's existing
 * definitions:
 *
 *   * **Tool catalog** ← each tool's TypeBox `parameters` schema → a PTC-Lisp
 *     signature string (planner guidance) + an effect tag (policy input).
 *   * **Provider catalog** ← the bundled model registry → `{alias, model}`
 *     pairs for any `llm_query` a program makes.
 *
 * A `check:catalog` CI gate (see `catalog-check.ts`) regenerates and diffs, so
 * the catalog can never silently drift from the tool/provider definitions.
 *
 * ## JSON-Schema → PTC signature
 *
 * TypeBox emits JSON-Schema-shaped objects. We map the structural subset Spell
 * tools actually use to PTC-Lisp's type vocabulary (per ptc_runner's
 * JSON-Schema→PTC convention): `:string :int :float :bool [:t] {k :t} :any`.
 * Unknown / unrepresentable constructs degrade to `:any` (never throw) — the
 * signature is guidance, not runtime validation.
 */

import type { TSchema } from "@sinclair/typebox";
import { type EffectTag, effectOf } from "./effects";

/** One tool entry in the generated catalog. */
export interface ToolCatalogEntry {
	name: string;
	/** PTC-Lisp signature, e.g. `(target :string, content :bool?) -> :any`. */
	signature: string;
	/** Capability/effect tag — the policy gate's input (see effects.ts). */
	effect: EffectTag;
	/** Short description (first line of the tool description, if any). */
	description?: string;
}

/** One provider alias in the generated catalog. */
export interface ProviderCatalogEntry {
	alias: string;
	model: string;
}

/** The full catalog handed to the runtime at `init`. */
export interface GeneratedCatalog {
	tools: ToolCatalogEntry[];
	providers: ProviderCatalogEntry[];
}

/** A tool definition the generator can read (structural subset of AgentTool). */
export interface CatalogTool {
	name: string;
	description?: string;
	parameters?: TSchema;
}

/** A model the generator can read (structural subset of Model). */
export interface CatalogModel {
	id: string;
	provider: string;
	cost: { input: number; output: number };
}

// ============================================================================
// Tool catalog
// ============================================================================

/** Generate tool catalog entries from tool definitions (sorted by name). */
export function generateToolCatalog(tools: CatalogTool[]): ToolCatalogEntry[] {
	return tools
		.map(t => ({
			name: t.name,
			signature: schemaToSignature(t.parameters),
			effect: effectOf(t.name),
			description: firstLine(t.description),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Convert a tool's TypeBox `parameters` object schema into a PTC-Lisp signature
 * `(field :type, optField :type?) -> :any`. Returns `() -> :any` for absent or
 * non-object schemas.
 */
export function schemaToSignature(schema: TSchema | undefined): string {
	const obj = schema as JsonSchema | undefined;
	if (!obj || obj.type !== "object" || !obj.properties) return "() -> :any";

	const required = new Set(obj.required ?? []);
	const params = Object.entries(obj.properties).map(([key, prop]) => {
		const ty = ptcType(prop);
		const opt = required.has(key) ? "" : "?";
		return `${key} ${ty}${opt}`;
	});

	return `(${params.join(", ")}) -> :any`;
}

/** Minimal JSON-Schema shape we introspect (TypeBox output is a superset). */
interface JsonSchema {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	allOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	const?: unknown;
	enum?: unknown[];
	patternProperties?: Record<string, JsonSchema>;
}

/** Map a JSON-Schema node to a PTC-Lisp type token. Total: never throws. */
export function ptcType(node: JsonSchema | undefined): string {
	if (!node || typeof node !== "object") return ":any";

	// Unions / enums → :any (PTC has no sum types in signatures).
	if (node.anyOf || node.oneOf || node.enum) return ":any";
	// Intersections → fall through to the first concrete branch if any.
	if (node.allOf && node.allOf.length > 0) return ptcType(node.allOf[0]);

	const t = Array.isArray(node.type) ? node.type[0] : node.type;
	switch (t) {
		case "string":
			return ":string";
		case "integer":
			return ":int";
		case "number":
			return ":float";
		case "boolean":
			return ":bool";
		case "array":
			return `[${ptcType(node.items)}]`;
		case "object":
			// A record (patternProperties) or a nested object → a map. We don't
			// expand nested object shapes in signatures (guidance only).
			return ":map";
		default:
			return ":any";
	}
}

// ============================================================================
// Provider catalog
// ============================================================================

/**
 * Generate provider aliases from the bundled model registry. We surface a small
 * set of semantic aliases (`fast`/`smart`/`cheap`) chosen by cost, plus every
 * model under its fully-qualified `provider/id` so programs can target exactly.
 */
export function generateProviderCatalog(models: CatalogModel[]): ProviderCatalogEntry[] {
	const fq = models.map(m => ({ alias: `${m.provider}/${m.id}`, model: `${m.provider}/${m.id}` }));

	const semantic = pickSemanticAliases(models);
	// Semantic aliases first (curated), then the full qualified set (sorted).
	return [...semantic, ...fq.sort((a, b) => a.alias.localeCompare(b.alias))];
}

/** Choose `cheap`/`fast`/`smart` aliases from cost signals; omit if no models. */
function pickSemanticAliases(models: CatalogModel[]): ProviderCatalogEntry[] {
	if (models.length === 0) return [];
	const byCost = [...models].sort((a, b) => totalCost(a) - totalCost(b));
	const cheapest = byCost[0];
	const priciest = byCost[byCost.length - 1];

	const out: ProviderCatalogEntry[] = [
		{ alias: "cheap", model: `${cheapest.provider}/${cheapest.id}` },
		{ alias: "fast", model: `${cheapest.provider}/${cheapest.id}` },
		{ alias: "smart", model: `${priciest.provider}/${priciest.id}` },
	];
	return out;
}

function totalCost(m: CatalogModel): number {
	return m.cost.input + m.cost.output;
}

// ============================================================================
// Full catalog
// ============================================================================

/** Assemble the full catalog from tool + model definitions. */
export function generateCatalog(tools: CatalogTool[], models: CatalogModel[]): GeneratedCatalog {
	return {
		tools: generateToolCatalog(tools),
		providers: generateProviderCatalog(models),
	};
}

function firstLine(s: string | undefined): string | undefined {
	if (!s) return undefined;
	const line = s.split("\n", 1)[0]?.trim();
	return line && line.length > 0 ? line : undefined;
}
