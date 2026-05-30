/**
 * Image-generation schema loader.
 *
 * Reads the bundled `defaults.kdl`, then folds in `image-generation { … }`
 * override blocks from the three spell.kdl tiers (user → project → local) in
 * ascending precedence. Self-contained: parses the tier files directly via the
 * same KDL path helpers Settings uses, so no plumbing through sdk.ts.
 *
 * TWO AUDIENCES (see defaults.kdl header) are kept distinct in the data model:
 *   - `instructions` is the tool description the LLM agent reads.
 *   - each field's `description` is a param doc the LLM reads.
 *   - `slot` + `prefix`/`sectionLabel` are assembly rules for the IMAGE prompt.
 *
 * Merge law (one rule, predictable):
 *   schema "X" with zero field nodes  → scalar patch (inherit bundled fields)
 *   schema "X" with ≥1 field node     → full field-set replace
 *   schema "X" new name               → added
 *   disable "X"                       → removed
 *
 * Fail-loud: unknown node inside a schema block, a field missing name or
 * description, a duplicate tool name, or an invalid aspect-ratio all throw with
 * the offending name. A tier file that fails to parse as KDL is warned + skipped
 * (matching parseSpellKdl), since that is a global config problem, not ours.
 */

import { type Document, type Node, parse } from "@bgotink/kdl";
import { getLocalKdlPath, getProjectDir, getProjectKdlPath, getUserKdlPath, logger } from "@spell/pi-utils";

import { getBooleanProperty, getStringArgument, getStringProperty } from "../../config/kdl-helpers";
import defaultsKdl from "./defaults.kdl" with { type: "text" };

// ─────────────────────────────────────────────────────────────────────────────
// Data model
// ─────────────────────────────────────────────────────────────────────────────

export type ImageSlot = "core" | "sentence" | "section";

export interface ImageSchemaField {
	/** Assembly slot — dispatched from the KDL node name. */
	slot: ImageSlot;
	/** Field name (arg0) — becomes a tool parameter key. */
	name: string;
	/** Param description (arg1) the LLM reads to fill a value. */
	description: string;
	/** Whether the tool parameter is required. */
	required: boolean;
	/** Sentence-slot prefix, e.g. "Layout:" → "Layout: <value>". */
	prefix?: string;
	/** Section-slot heading, e.g. "Components" → "\n\nComponents: <value>". */
	sectionLabel?: string;
}

export interface ImageSchema {
	/** Schema name (merge key), e.g. "cinematic". */
	name: string;
	/** Tool name exposed to the LLM, e.g. "generate_image". */
	toolName: string;
	/** Display label, derived from toolName unless `label "…"` overrides. */
	label: string;
	/** Tool description (LLM audience). */
	instructions: string;
	/** Default aspect ratio surfaced in the param doc; per-call arg wins. */
	aspectRatioDefault?: string;
	/** Prompt-vocabulary fields, in declaration order. */
	fields: ImageSchemaField[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SLOTS = new Set<ImageSlot>(["core", "sentence", "section"]);
const SCALAR_NODES = new Set(["tool", "label", "instructions", "aspect-ratio"]);
/** Mirror of `aspectRatioSchema` in image-generation.ts. */
const VALID_ASPECT_RATIOS = new Set(["1:1", "3:4", "4:3", "9:16", "16:9"]);

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/** Partial schema parsed from one `schema "X" { … }` node, before merge. */
interface ParsedSchema {
	name: string;
	toolName?: string;
	label?: string;
	instructions?: string;
	aspectRatioDefault?: string;
	fields: ImageSchemaField[];
}

/** Derive a PascalCase display label from a snake_case tool name. */
function deriveLabel(toolName: string): string {
	return toolName
		.split("_")
		.filter(Boolean)
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function parseField(node: Node, schemaName: string): ImageSchemaField {
	const slot = node.getName() as ImageSlot;
	const name = getStringArgument(node, 0);
	const description = getStringArgument(node, 1);
	if (!name) {
		throw new Error(`image-generation schema "${schemaName}": ${slot} field is missing its name (arg0).`);
	}
	if (!description) {
		throw new Error(
			`image-generation schema "${schemaName}": ${slot} field "${name}" is missing its description (arg1).`,
		);
	}
	return {
		slot,
		name,
		description,
		required: getBooleanProperty(node, "required") ?? false,
		prefix: getStringProperty(node, "prefix"),
		sectionLabel: getStringProperty(node, "label"),
	};
}

function parseSchemaNode(node: Node): ParsedSchema {
	const name = getStringArgument(node, 0);
	if (!name) {
		throw new Error('image-generation: a `schema` node is missing its name (e.g. schema "cinematic").');
	}

	const parsed: ParsedSchema = { name, fields: [] };
	for (const child of node.children?.nodes ?? []) {
		const childName = child.getName();
		if (SLOTS.has(childName as ImageSlot)) {
			parsed.fields.push(parseField(child, name));
			continue;
		}
		if (!SCALAR_NODES.has(childName)) {
			throw new Error(
				`image-generation schema "${name}": unknown node "${childName}". ` +
					`Expected one of: tool, label, instructions, aspect-ratio, core, sentence, section.`,
			);
		}
		const value = getStringArgument(child, 0);
		switch (childName) {
			case "tool":
				parsed.toolName = value;
				break;
			case "label":
				parsed.label = value;
				break;
			case "instructions":
				parsed.instructions = value;
				break;
			case "aspect-ratio":
				if (value && !VALID_ASPECT_RATIOS.has(value)) {
					throw new Error(
						`image-generation schema "${name}": invalid aspect-ratio "${value}". ` +
							`Expected one of: ${[...VALID_ASPECT_RATIOS].join(", ")}.`,
					);
				}
				parsed.aspectRatioDefault = value;
				break;
		}
	}
	return parsed;
}

/** Finalize a brand-new schema (no bundled base to inherit from). */
function finalizeNew(parsed: ParsedSchema): ImageSchema {
	if (!parsed.toolName) {
		throw new Error(`image-generation schema "${parsed.name}": new schemas must declare a \`tool "…"\` node.`);
	}
	return {
		name: parsed.name,
		toolName: parsed.toolName,
		label: parsed.label ?? deriveLabel(parsed.toolName),
		instructions: parsed.instructions ?? "",
		aspectRatioDefault: parsed.aspectRatioDefault,
		fields: parsed.fields,
	};
}

/** Apply an override schema onto an existing bundled schema. */
function applyOverride(base: ImageSchema, parsed: ParsedSchema): ImageSchema {
	// Zero fields → scalar patch (inherit fields). ≥1 field → full replace.
	const fields = parsed.fields.length > 0 ? parsed.fields : base.fields;
	const toolName = parsed.toolName ?? base.toolName;
	// An explicit label wins; else if the tool name changed, re-derive; else keep.
	const label = parsed.label ?? (parsed.toolName ? deriveLabel(parsed.toolName) : base.label);
	return {
		name: base.name,
		toolName,
		label,
		instructions: parsed.instructions ?? base.instructions,
		aspectRatioDefault: parsed.aspectRatioDefault ?? base.aspectRatioDefault,
		fields,
	};
}

/** Fold one tier's `image-generation` child nodes into the schema map (in place). */
function applyTier(schemas: Map<string, ImageSchema>, blockNodes: Node[]): void {
	for (const node of blockNodes) {
		const nodeName = node.getName();
		if (nodeName === "disable") {
			const target = getStringArgument(node, 0);
			if (!target) continue;
			if (!schemas.delete(target)) {
				logger.warn("image-generation: disable target not found", { target });
			}
			continue;
		}
		if (nodeName !== "schema") {
			throw new Error(
				`image-generation: unknown node "${nodeName}" in override block. Expected "schema" or "disable".`,
			);
		}
		const parsed = parseSchemaNode(node);
		const existing = schemas.get(parsed.name);
		schemas.set(parsed.name, existing ? applyOverride(existing, parsed) : finalizeNew(parsed));
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier reading
// ─────────────────────────────────────────────────────────────────────────────

/** Collect child nodes of every `image-generation` block in a document. */
function imageGenerationBlockNodes(doc: Document): Node[] {
	const out: Node[] = [];
	for (const block of doc.findNodesByName("image-generation")) {
		out.push(...(block.children?.nodes ?? []));
	}
	return out;
}

/** Parse a spell.kdl tier file and return its image-generation override nodes. */
async function readTierBlocks(kdlPath: string): Promise<Node[]> {
	if (!kdlPath) return [];
	let content: string;
	try {
		content = await Bun.file(kdlPath).text();
	} catch {
		return []; // Missing tier file — nothing to override.
	}
	let doc: Document;
	try {
		doc = parse(content);
	} catch (error) {
		logger.warn("image-generation: skipping tier with unparseable KDL", {
			path: kdlPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
	return imageGenerationBlockNodes(doc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadImageSchemasOptions {
	/** Project directory for resolving project/local spell.kdl. Defaults to getProjectDir(). */
	cwd?: string;
	/**
	 * Explicit override blocks, in ascending precedence. When provided, tier
	 * files are NOT read (used by tests). Each inner array is one tier's nodes.
	 */
	overrideTiers?: Node[][];
}

/** Parse raw KDL text into ordered override nodes (test helper + reuse). */
export function parseOverrideBlocks(kdl: string): Node[] {
	return imageGenerationBlockNodes(parse(kdl));
}

/** Parse the bundled defaults into a name-keyed schema map. */
function loadDefaults(): Map<string, ImageSchema> {
	const doc = parse(defaultsKdl);
	const schemas = new Map<string, ImageSchema>();
	for (const node of doc.findNodesByName("schema")) {
		const finalized = finalizeNew(parseSchemaNode(node));
		schemas.set(finalized.name, finalized);
	}
	return schemas;
}

/** Throw if two schemas expose the same tool name (would shadow at registration). */
function assertUniqueToolNames(schemas: Iterable<ImageSchema>): void {
	const seen = new Map<string, string>();
	for (const schema of schemas) {
		const prior = seen.get(schema.toolName);
		if (prior) {
			throw new Error(
				`image-generation: duplicate tool name "${schema.toolName}" ` +
					`(schemas "${prior}" and "${schema.name}").`,
			);
		}
		seen.set(schema.toolName, schema.name);
	}
}

/**
 * Load all image schemas: bundled defaults overlaid by spell.kdl tiers.
 * Tiers apply in ascending precedence (user → project → local).
 *
 * REFACTOR (deferred): this loader reads the three spell.kdl tiers DIRECTLY,
 * rather than flowing through `config/spell-kdl.ts::parseSpellKdl` like every
 * other top-level block (agents, modes, providers). That makes
 * `image-generation` the lone config block invisible to the central parser
 * (it hits parseSpellKdl's `default: break`) and re-parses spell.kdl a second
 * time per session. Chosen deliberately to keep the feature self-contained
 * during bring-up. Once the codebase's KDL handling has settled, unify this
 * into parseSpellKdl: add a `case "image-generation"`, store the raw override
 * nodes on SpellProjectConfig, merge across tiers in mergeSpellConfigs, and
 * pass them in via `overrideTiers` (the option already exists for exactly this
 * hand-off — no signature change needed here). Tracked: FUP image-generation
 * KDL unification.
 */
export async function loadImageSchemas(options: LoadImageSchemasOptions = {}): Promise<ImageSchema[]> {
	const schemas = loadDefaults();

	const tiers =
		options.overrideTiers ??
		(await (async () => {
			const cwd = options.cwd ?? getProjectDir();
			const [user, project, local] = await Promise.all([
				readTierBlocks(getUserKdlPath()),
				readTierBlocks(getProjectKdlPath(cwd)),
				readTierBlocks(getLocalKdlPath(cwd)),
			]);
			return [user, project, local];
		})());

	for (const tier of tiers) {
		applyTier(schemas, tier);
	}

	const result = [...schemas.values()];
	assertUniqueToolNames(result);
	return result;
}
