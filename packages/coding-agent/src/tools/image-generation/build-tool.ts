/**
 * Schema -> CustomTool factory.
 *
 * Turns one `ImageSchema` (parsed from KDL) into a registered tool. The tool's
 * parameters are the schema's vocabulary fields plus the COMMON params
 * (aspect_ratio, image_size, input, changes) injected here -- those are
 * provider-level, not prompt vocabulary, so they live in code, not KDL.
 *
 * On call: split params into vocabulary values vs. common params, assemble the
 * image prompt from the vocabulary (prompt-assembly.ts), then delegate to the
 * injected `runImageGeneration`. Keeping the runner injected avoids an import
 * cycle with image-generation.ts (which imports this module).
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { type Static, type TSchema, Type } from "@sinclair/typebox";

import { renderPromptTemplate } from "../../config/prompt-templates";
import type { CustomTool, CustomToolContext } from "../../extensibility/custom-tools/types";
import type { ImageGenerationToolDetails, ImageInput, RunImageGenerationInput } from "../image-generation";
import { assembleImagePrompt } from "./prompt-assembly";
import type { ImageSchema } from "./schema-loader";

// ─────────────────────────────────────────────────────────────────────────────
// Common param atoms (provider-level, injected into every image tool)
// ─────────────────────────────────────────────────────────────────────────────

const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;

const imageSizeSchema = StringEnum(["1024x1024", "1536x1024", "1024x1536"], {
	description: "Image size, mainly for gemini-3-pro-image-preview.",
});

const inputImageSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Path to an input image file." })),
		data: Type.Optional(Type.String({ description: "Base64 image data or a data: URL." })),
		mime_type: Type.Optional(Type.String({ description: "Required for raw base64 data." })),
	},
	{ additionalProperties: false },
);

const changesSchema = Type.Array(Type.String(), {
	description:
		"For edits: specific changes to make, as well as what to keep unchanged (e.g., ['Change the tie to green', 'Remove the car in background']). Use with input.",
});

/** Reserved param keys injected by the builder; schema field names must not collide. */
const RESERVED_PARAM_NAMES = new Set(["aspect_ratio", "image_size", "input", "changes"]);

/** Aspect-ratio param whose description surfaces this schema's live default. */
function aspectRatioParam(defaultValue?: string): TSchema {
	const base = `Aspect ratio (${ASPECT_RATIOS.join(", ")}).`;
	const description = defaultValue ? `${base} Defaults to ${defaultValue}.` : base;
	return StringEnum([...ASPECT_RATIOS], { description });
}

// ─────────────────────────────────────────────────────────────────────────────
// Param schema assembly
// ─────────────────────────────────────────────────────────────────────────────

function buildParameters(schema: ImageSchema): TSchema {
	const properties: Record<string, TSchema> = {};
	const required: string[] = [];

	for (const field of schema.fields) {
		if (RESERVED_PARAM_NAMES.has(field.name)) {
			throw new Error(
				`image-generation schema "${schema.name}": field "${field.name}" collides with a reserved ` +
					`common param (${[...RESERVED_PARAM_NAMES].join(", ")}).`,
			);
		}
		const prop = Type.String({ description: field.description });
		if (field.required) {
			properties[field.name] = prop;
			required.push(field.name);
		} else {
			properties[field.name] = Type.Optional(prop);
		}
	}

	// Common params -- same shape for every image tool.
	properties.aspect_ratio = Type.Optional(aspectRatioParam(schema.aspectRatioDefault));
	properties.image_size = Type.Optional(imageSizeSchema);
	properties.changes = Type.Optional(changesSchema);
	properties.input = Type.Optional(
		Type.Array(inputImageSchema, { description: "Optional input images for edits or variations." }),
	);

	return Type.Object(properties, { additionalProperties: false, required });
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

type RunImageGeneration = (
	req: RunImageGenerationInput,
	ctx: CustomToolContext,
	signal?: AbortSignal,
) => Promise<AgentToolResult<ImageGenerationToolDetails>>;

export function buildImageTool(
	schema: ImageSchema,
	run: RunImageGeneration,
): CustomTool<TSchema, ImageGenerationToolDetails> {
	const parameters = buildParameters(schema);
	const fieldNames = schema.fields.map(field => field.name);

	return {
		name: schema.toolName,
		label: schema.label,
		description: renderPromptTemplate(schema.instructions),
		parameters,
		async execute(_toolCallId, params, _onUpdate, ctx, signal) {
			const args = params as Static<typeof parameters> & {
				aspect_ratio?: string;
				image_size?: string;
				input?: ImageInput[];
				changes?: string[];
			} & Record<string, string | undefined>;

			// Split vocabulary field values from common params for assembly.
			const values: Record<string, string | undefined> = {};
			for (const name of fieldNames) {
				const value = args[name];
				if (typeof value === "string") values[name] = value;
			}

			const prompt = assembleImagePrompt({ fields: schema.fields, values, changes: args.changes });

			return run(
				{
					prompt,
					aspect_ratio: args.aspect_ratio,
					image_size: args.image_size,
					input: args.input,
				},
				ctx,
				signal,
			);
		},
	};
}
