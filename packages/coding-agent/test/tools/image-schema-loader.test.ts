import { describe, expect, it } from "bun:test";

import { assembleImagePrompt } from "@oh-my-pi/pi-coding-agent/tools/image-generation/prompt-assembly";
import {
	type ImageSchema,
	loadImageSchemas,
	parseOverrideBlocks,
} from "@oh-my-pi/pi-coding-agent/tools/image-generation/schema-loader";

/** Load with explicit override tiers (no filesystem). */
function load(...tiers: string[][]): Promise<ImageSchema[]> {
	return loadImageSchemas({ overrideTiers: tiers.map(tier => tier.flatMap(parseOverrideBlocks)) });
}

function byName(schemas: ImageSchema[], name: string): ImageSchema {
	const found = schemas.find(s => s.name === name);
	if (!found) throw new Error(`schema "${name}" not found in [${schemas.map(s => s.name).join(", ")}]`);
	return found;
}

describe("loadImageSchemas — bundled defaults (read from defaults.kdl)", () => {
	it("reads the two bundled schemas with their fields and instructions from file", async () => {
		const schemas = await load();
		expect(schemas.map(s => s.name).sort()).toEqual(["cinematic", "ui-screen"]);

		const cinematic = byName(schemas, "cinematic");
		expect(cinematic.toolName).toBe("generate_image");
		expect(cinematic.label).toBe("GenerateImage"); // derived from tool name
		expect(cinematic.aspectRatioDefault).toBe("1:1");
		expect(cinematic.fields.map(f => f.name)).toEqual([
			"subject",
			"action",
			"scene",
			"composition",
			"lighting",
			"style",
			"text",
		]);
		// subject is the only required field
		expect(cinematic.fields.filter(f => f.required).map(f => f.name)).toEqual(["subject"]);
		// instructions (LLM-facing prompt) come straight from the KDL file
		expect(cinematic.instructions).toContain("Generates or edits images");
		expect(cinematic.instructions).toContain("<instructions>");
		// section slot carries its label; raw string preserves embedded quotes
		const text = cinematic.fields.find(f => f.name === "text")!;
		expect(text.slot).toBe("section");
		expect(text.sectionLabel).toBe("Text");
		expect(text.description).toContain('"URBAN EXPLORER"');
	});

	it("reads the ui-screen schema with derived label and desktop default", async () => {
		const ui = byName(await load(), "ui-screen");
		expect(ui.toolName).toBe("generate_ui_screen");
		expect(ui.label).toBe("GenerateUiScreen");
		expect(ui.aspectRatioDefault).toBe("16:9");
		const platform = ui.fields.find(f => f.name === "platform")!;
		expect(platform.slot).toBe("sentence");
		expect(platform.prefix).toBe("Platform:");
	});
});

describe("loadImageSchemas — override merge", () => {
	it("scalar patch: zero field nodes inherits bundled fields, overrides the scalar", async () => {
		const schemas = await load([`image-generation { schema "ui-screen" { aspect-ratio "4:3" } }`]);
		const ui = byName(schemas, "ui-screen");
		expect(ui.aspectRatioDefault).toBe("4:3"); // overridden
		// fields inherited unchanged
		expect(ui.fields.map(f => f.name)).toEqual([
			"screen",
			"platform",
			"layout",
			"state",
			"interactions",
			"components",
			"tokens",
		]);
	});

	it("full replace: ≥1 field node replaces the entire field set", async () => {
		const schemas = await load([
			`image-generation { schema "cinematic" { core "subject" "Only subject." required=#true } }`,
		]);
		const cinematic = byName(schemas, "cinematic");
		expect(cinematic.fields.map(f => f.name)).toEqual(["subject"]);
		expect(cinematic.fields[0]!.description).toBe("Only subject.");
		// untouched scalars inherited
		expect(cinematic.toolName).toBe("generate_image");
		expect(cinematic.aspectRatioDefault).toBe("1:1");
	});

	it("add: a new schema name is appended", async () => {
		const schemas = await load([
			`image-generation {
				schema "pixel-art" {
					tool "generate_pixel_art"
					core "subject" "Pixel-art subject." required=#true
					sentence "palette" "Named palette." prefix="Palette:"
				}
			}`,
		]);
		expect(schemas.map(s => s.name).sort()).toEqual(["cinematic", "pixel-art", "ui-screen"]);
		const pixel = byName(schemas, "pixel-art");
		expect(pixel.label).toBe("GeneratePixelArt"); // derived
		expect(pixel.fields.map(f => f.name)).toEqual(["subject", "palette"]);
	});

	it("disable: removes a bundled schema", async () => {
		const schemas = await load([`image-generation { disable "cinematic" }`]);
		expect(schemas.map(s => s.name)).toEqual(["ui-screen"]);
	});

	it("tiers apply in ascending precedence (later tier wins)", async () => {
		const schemas = await load(
			[`image-generation { schema "ui-screen" { aspect-ratio "4:3" } }`], // project
			[`image-generation { schema "ui-screen" { aspect-ratio "1:1" } }`], // local
		);
		expect(byName(schemas, "ui-screen").aspectRatioDefault).toBe("1:1");
	});

	it("explicit label override beats derivation", async () => {
		const schemas = await load([`image-generation { schema "cinematic" { label "Cinematic Image" } }`]);
		expect(byName(schemas, "cinematic").label).toBe("Cinematic Image");
	});
});

describe("loadImageSchemas — fail-loud validation", () => {
	it("throws on an unknown node inside a schema block", async () => {
		await expect(load([`image-generation { schema "cinematic" { whoops "x" } }`])).rejects.toThrow(
			/unknown node "whoops"/,
		);
	});

	it("throws on a field missing its description", async () => {
		await expect(load([`image-generation { schema "x" { tool "t"; core "subject" } }`])).rejects.toThrow(
			/missing its description/,
		);
	});

	it("throws on an invalid aspect-ratio", async () => {
		await expect(load([`image-generation { schema "cinematic" { aspect-ratio "21:9" } }`])).rejects.toThrow(
			/invalid aspect-ratio "21:9"/,
		);
	});

	it("throws on a new schema with no tool name", async () => {
		await expect(load([`image-generation { schema "novel" { core "subject" "S." } }`])).rejects.toThrow(
			/must declare a `tool/,
		);
	});

	it("throws on a duplicate tool name across schemas", async () => {
		await expect(
			load([`image-generation { schema "twin" { tool "generate_image"; core "subject" "S." } }`]),
		).rejects.toThrow(/duplicate tool name "generate_image"/);
	});

	it("throws on an unknown node in the override block root", async () => {
		await expect(load([`image-generation { nonsense "x" }`])).rejects.toThrow(/unknown node "nonsense"/);
	});
});

describe("assembleImagePrompt — slot-driven image prompt", () => {
	it("reproduces the cinematic sentence structure", async () => {
		const cinematic = (await load()).find(s => s.name === "cinematic")!;
		const prompt = assembleImagePrompt({
			fields: cinematic.fields,
			values: {
				subject: "a robot barista",
				action: "pouring latte art",
				scene: "in a Mars café",
				composition: "low-angle close-up",
				style: "film noir",
			},
		});
		expect(prompt).toBe("a robot barista, pouring latte art, in a Mars café. low-angle close-up. film noir.");
	});

	it("renders section blocks with their labels", async () => {
		const cinematic = (await load()).find(s => s.name === "cinematic")!;
		const prompt = assembleImagePrompt({
			fields: cinematic.fields,
			values: { subject: "a poster", text: "BIG SALE" },
		});
		expect(prompt).toBe("a poster.\n\nText: BIG SALE");
	});

	it("prepends sentence prefixes and appends edit changes", async () => {
		const ui = (await load()).find(s => s.name === "ui-screen")!;
		const prompt = assembleImagePrompt({
			fields: ui.fields,
			values: { screen: "login screen", platform: "iOS mobile", components: "email field, button" },
			changes: ["make the button blue", "keep the logo"],
		});
		expect(prompt).toBe(
			"login screen. Platform: iOS mobile.\n\nComponents: email field, button\n\nChanges:\n- make the button blue\n- keep the logo",
		);
	});
});
