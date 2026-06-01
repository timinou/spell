import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkillsFromDir, type Skill } from "@spell/pi-coding-agent/extensibility/skills";
import { buildSystemPrompt } from "@spell/pi-coding-agent/system-prompt";

const readTool = new Map([
	[
		"read",
		{
			label: "Read",
			description: "Read files from the workspace",
		},
	] as const,
]);

function renderSkillBlockText(skills: Skill[], cwd: string): Promise<string> {
	return buildSystemPrompt({
		contextFiles: [],
		cwd,
		rules: [],
		skills,
		toolNames: ["read"],
		tools: readTool,
	}).then(blocks => blocks.map(block => block.text).join("\n"));
}

async function writeSkill(dir: string, name: string, frontmatter: string[]): Promise<void> {
	const skillDir = path.join(dir, name);
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(path.join(skillDir, "SKILL.md"), frontmatter.join("\n"), "utf8");
}

describe("skill globs", () => {
	it("retains frontmatter globs when loading skills", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-globs-load-"));

		try {
			await writeSkill(tempDir, "typst-skill", [
				"---",
				"name: typst-skill",
				"description: Typst support",
				"globs:",
				"  - '**/*.typ'",
				"---",
				"",
				"# Typst",
			]);

			const result = await loadSkillsFromDir({ dir: tempDir, source: "test" });
			const loaded = result.skills.find(skill => skill.name === "typst-skill");

			expect(loaded?.globs).toEqual(["**/*.typ"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("omits globbed skills when the workspace has no matching files", async () => {
		const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-globs-empty-"));
		const skills: Skill[] = [
			{
				name: "typst-skill",
				description: "Typst support",
				filePath: "/tmp/typst/SKILL.md",
				baseDir: "/tmp/typst",
				source: "test",
				globs: ["**/*.typ"],
			},
			{
				name: "baseline-skill",
				description: "Always on",
				filePath: "/tmp/base/SKILL.md",
				baseDir: "/tmp/base",
				source: "test",
			},
		];

		try {
			const prompt = await renderSkillBlockText(skills, tempWorkspace);
			expect(prompt).toContain("baseline-skill");
			expect(prompt).not.toContain("typst-skill");
		} finally {
			await fs.rm(tempWorkspace, { recursive: true, force: true });
		}
	});

	it("includes globbed skills when the workspace has a matching .typ file", async () => {
		const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-globs-match-"));
		const skills: Skill[] = [
			{
				name: "typst-skill",
				description: "Typst support",
				filePath: "/tmp/typst/SKILL.md",
				baseDir: "/tmp/typst",
				source: "test",
				globs: ["**/*.typ"],
			},
			{
				name: "baseline-skill",
				description: "Always on",
				filePath: "/tmp/base/SKILL.md",
				baseDir: "/tmp/base",
				source: "test",
			},
		];

		try {
			await fs.writeFile(path.join(tempWorkspace, "doc.typ"), "= Typst\n", "utf8");
			const prompt = await renderSkillBlockText(skills, tempWorkspace);
			expect(prompt).toContain("baseline-skill");
			expect(prompt).toContain("typst-skill");
		} finally {
			await fs.rm(tempWorkspace, { recursive: true, force: true });
		}
	});
});
