import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";

describe("gitRoot warning", () => {
	test("renders when gitRoot differs from cwd", async () => {
		const tpl = await Bun.file(
			path.join(import.meta.dir, "..", "src", "prompts", "system", "system-prompt.md"),
		).text();
		const out = renderPromptTemplate(tpl, { cwd: "/proj/apps/foo", gitRoot: "/proj", date: "2026-05-10" });
		expect(out).toContain("git root: '/proj'");
		expect(out).toContain("tool paths resolve from cwd");
	});
	test("absent when gitRoot is null", async () => {
		const tpl = await Bun.file(
			path.join(import.meta.dir, "..", "src", "prompts", "system", "system-prompt.md"),
		).text();
		const out = renderPromptTemplate(tpl, { cwd: "/proj", gitRoot: null, date: "2026-05-10" });
		expect(out).not.toContain("git root:");
	});
});
