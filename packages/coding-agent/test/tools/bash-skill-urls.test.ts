import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Skill } from "../../src/extensibility/skills";
import { resolveLocalUrlToPath } from "../../src/internal-urls";
import { expandInternalUrls, expandSkillUrls } from "../../src/tools/bash-skill-urls";
import { ToolError } from "../../src/tools/tool-errors";

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

function createSkill(name: string, baseDir: string): Skill {
	const resolvedBaseDir = path.resolve(baseDir);
	return {
		name,
		description: `${name} description`,
		filePath: path.join(resolvedBaseDir, "SKILL.md"),
		baseDir: resolvedBaseDir,
		source: "test",
	};
}

function createInternalRouter(resources: Record<string, { sourcePath?: string; error?: string }>): {
	canHandle: (input: string) => boolean;
	resolve: (
		input: string,
	) => Promise<{ url: string; content: string; contentType: "text/plain"; sourcePath?: string }>;
} {
	return {
		canHandle: input => /^(agent|artifact|plan|memory|rule):\/\//.test(input),
		resolve: async input => {
			const entry = resources[input];
			if (!entry) {
				throw new Error(`No mapping for ${input}`);
			}
			if (entry.error) {
				throw new Error(entry.error);
			}
			return {
				url: input,
				content: "",
				contentType: "text/plain",
				sourcePath: entry.sourcePath,
			};
		},
	};
}

describe("expandSkillUrls", () => {
	it("expands a basic skill:// URI to an absolute path", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python skill://valid-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands multiple skill:// URIs in one command", () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];
		const command = "cp skill://first-skill/a.txt skill://second-skill/b.txt";
		const firstPath = path.join(skills[0].baseDir, "a.txt");
		const secondPath = path.join(skills[1].baseDir, "b.txt");

		expect(expandSkillUrls(command, skills)).toBe(`cp ${shellEscape(firstPath)} ${shellEscape(secondPath)}`);
	});

	it("throws ToolError for unknown skills with available names", () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];

		expect(() => expandSkillUrls("python skill://missing/run.py", skills)).toThrow(
			"Unknown skill: missing. Available: first-skill, second-skill",
		);
	});

	it("throws ToolError for path traversal attempts", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];

		expect(() => expandSkillUrls("cat skill://valid-skill/../../../etc/passwd", skills)).toThrow(
			"Path traversal (..) is not allowed in skill:// URLs",
		);
	});

	it("returns command unchanged when there are no skill:// tokens", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "git status";

		expect(expandSkillUrls(command, skills)).toBe(command);
	});

	it("does not expand non-skill internal URIs", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "echo agent://1 artifact://abc rule://security";

		expect(expandSkillUrls(command, skills)).toBe(command);
	});

	it("expands URI in double quotes", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'python "skill://valid-skill/scripts/init.py"';
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands URI in single quotes", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python 'skill://valid-skill/scripts/init.py'";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths with spaces", () => {
		const skills = [createSkill("space-skill", "/tmp/skills/with space")];
		const command = "python skill://space-skill/scripts/my%20file.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/my file.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths containing single quotes", () => {
		const skills = [createSkill("quote-skill", "/tmp/skills/with'quote")];
		const command = "python skill://quote-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		expect(expandSkillUrls(command, skills)).toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("resolves skill://name with no relative path to SKILL.md", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "cat skill://valid-skill";

		expect(expandSkillUrls(command, skills)).toBe(`cat ${shellEscape(skills[0].filePath)}`);
	});

	it("returns command unchanged when no skills are loaded", () => {
		const command = "python skill://valid-skill/scripts/init.py";
		expect(expandSkillUrls(command, [])).toBe(command);
	});

	it("throws ToolError when traversal is attempted with encoded segments", () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		expect(() => expandSkillUrls("cat skill://valid-skill/%2E%2E/%2E%2E/etc/passwd", skills)).toThrow(ToolError);
	});
});

describe("expandInternalUrls", () => {
	// PLAN-310: composite skill/agent/artifact/memory/rule expansion test
	// removed — all schemes except artifact are kernel-owned and pass through
	// to brush WordPreprocessor. Per-scheme tests cover the contract.

	it("expands quoted non-skill URLs and shell-escapes quotes in paths", async () => {
		const router = createInternalRouter({
			"artifact://7": { sourcePath: "/tmp/artifacts/with'quote.log" },
		});
		await expect(expandInternalUrls('cat "artifact://7"', { skills: [], internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/artifacts/with'quote.log")}`,
		);
	});

	it("passes agent:// URLs through unchanged (PLAN-310: kernel-owned via §agent)", async () => {
		const router = createInternalRouter({
			"agent://abc": { sourcePath: "/tmp/session/abc.md" },
		});
		// agent:// is kernel-owned: TS pre-pass is a no-op; brush in the kernel
		// shell exec resolves the URL via SchemeRegistry just before running.
		await expect(expandInternalUrls("echo agent://abc", { skills: [], internalRouter: router })).resolves.toBe(
			`echo ${shellEscape("agent://abc")}`,
		);
	});

	it("expands local:// URLs to filesystem paths without requiring preexisting files", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "mv /tmp/source.json local://handoffs/new-file.json";
		const expectedPath = resolveLocalUrlToPath("local://handoffs/new-file.json", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`mv /tmp/source.json ${shellEscape(expectedPath)}`,
		);
	});

	it("throws when local:// URL is used without local protocol options", async () => {
		await expect(expandInternalUrls("mv foo local://bar", { skills: [] })).rejects.toThrow(
			"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
		);
	});

	it("throws when non-skill URL is used without an internal router", async () => {
		await expect(expandInternalUrls("cat artifact://1", { skills: [] })).rejects.toThrow(
			"Cannot resolve artifact:// URL in bash command",
		);
	});


	it("surfaces resolver errors with actionable context (for JS-routed schemes)", async () => {
		// PLAN-310: memory:// is kernel-owned and passes through; use a still-JS-routed
		// scheme (artifact://) to validate error surfacing.
		const router = createInternalRouter({
			"artifact://missing": { error: "Artifact not found" },
		});
		await expect(
			expandInternalUrls("cat artifact://missing", { skills: [], internalRouter: router }),
		).rejects.toThrow("Failed to resolve artifact:// URL in bash command");
	});
});
