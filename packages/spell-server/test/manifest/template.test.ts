import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadManifestFromFile, parseManifestKdl, serializeManifestKdl } from "../../src/manifest";

const HEADER = `name "spell-templates"\nversion "1.0"\nsetup "writer" { domain "coding" }\n`;

describe("template parser", () => {
	it("parses minimal template (setup + prompt)", () => {
		const manifest = parseManifestKdl(
			`${HEADER}template "doc" {\n\tsetup "writer"\n\tprompt "Hello"\n}`,
		);
		const tpl = manifest.templates.get("doc");
		expect(tpl).toBeDefined();
		expect(tpl?.setupRef).toBe("writer");
		expect(tpl?.prompt).toBe("Hello");
		expect(tpl?.params).toEqual([]);
		expect(tpl?.artifactWatch).toBeUndefined();
		expect(tpl?.mode).toBeUndefined();
	});

	it("parses template with typed params", () => {
		const manifest = parseManifestKdl(
			`${HEADER}template "doc" {
				setup "writer"
				prompt "Hi"
				param "topic" type="string" required=#true
				param "depth" type="number"
			}`,
		);
		const tpl = manifest.templates.get("doc");
		expect(tpl?.params).toEqual([
			{ name: "topic", type: "string", required: true },
			{ name: "depth", type: "number" },
		]);
	});

	it("parses artifact-watch with positional ext args, lowercase-normalized", () => {
		const manifest = parseManifestKdl(
			`${HEADER}template "doc" {
				setup "writer"
				prompt "Hi"
				artifact-watch ".PDF" ".png"
			}`,
		);
		expect(manifest.templates.get("doc")?.artifactWatch).toEqual({ ext: [".pdf", ".png"] });
	});

	it("parses explicit mode \"rpc\"", () => {
		const manifest = parseManifestKdl(
			`${HEADER}template "doc" {\n\tsetup "writer"\n\tprompt "Hi"\n\tmode "rpc"\n}`,
		);
		expect(manifest.templates.get("doc")?.mode).toBe("rpc");
	});

	it("rejects mode outside the allowed set", () => {
		expect(() =>
			parseManifestKdl(
				`${HEADER}template "doc" {\n\tsetup "writer"\n\tprompt "Hi"\n\tmode "plan"\n}`,
			),
		).toThrow(/mode must be one of/);
	});

	it("rejects duplicate template names", () => {
		expect(() =>
			parseManifestKdl(
				`${HEADER}template "doc" {\n\tsetup "writer"\n\tprompt "a"\n}\ntemplate "doc" {\n\tsetup "writer"\n\tprompt "b"\n}`,
			),
		).toThrow(/Duplicate template/);
	});

	it("rejects duplicate parameter names within a template", () => {
		expect(() =>
			parseManifestKdl(
				`${HEADER}template "doc" {\n\tsetup "writer"\n\tprompt "Hi"\n\tparam "topic" type="string"\n\tparam "topic" type="number"\n}`,
			),
		).toThrow(/duplicate name/);
	});

	it("rejects empty prompt at validation", () => {
		expect(() =>
			parseManifestKdl(
				`${HEADER}template "doc" {\n\tsetup "writer"\n\tprompt ""\n}`,
			),
		).toThrow(/templates\.doc\.prompt|required/);
	});

	it("rejects unresolved setup ref at validation", () => {
		expect(() =>
			parseManifestKdl(
				`${HEADER}template "doc" {\n\tsetup "missing"\n\tprompt "Hi"\n}`,
			),
		).toThrow(/templates\.doc\.setup/);
	});

	it("rejects artifact-watch ext without leading dot", () => {
		expect(() =>
			parseManifestKdl(
				`${HEADER}template "doc" {\n\tsetup "writer"\n\tprompt "Hi"\n\tartifact-watch "pdf"\n}`,
			),
		).toThrow(/must match/);
	});

	it("round-trips parse \u2192 serialize \u2192 parse identical", () => {
		const original = parseManifestKdl(
			`${HEADER}template "doc" {
				setup "writer"
				description "Generate a PDF"
				mode "rpc"
				prompt "Generate {{topic}}"
				param "topic" type="string" required=#true
				param "depth" type="number"
				artifact-watch ".pdf" ".png"
			}`,
		);
		const rendered = serializeManifestKdl(original);
		const reparsed = parseManifestKdl(rendered);
		expect([...reparsed.templates.entries()]).toEqual([...original.templates.entries()]);
	});

	it("merges imported templates under <alias>.<name>", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spell-template-import-"));
		const subPath = path.join(tmp, "tpls.kdl");
		await Bun.write(
			subPath,
			`name "tpls"\nversion "1.0"\nsetup "writer" { domain "coding" }\ntemplate "doc" {\n\tsetup "writer"\n\tprompt "Hi"\n}`,
		);
		const rootPath = path.join(tmp, "manifest.kdl");
		await Bun.write(
			rootPath,
			`name "root"\nversion "1.0"\nimport "./tpls.kdl" as="x"\n`,
		);
		const manifest = await loadManifestFromFile(rootPath);
		expect(manifest.templates.has("x.doc")).toBe(true);
		expect(manifest.templates.get("x.doc")?.setupRef).toBe("x.writer");
	});
});
