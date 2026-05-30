/**
 * Tests for AgentDashboard component.
 *
 * Wave-2 coverage (TDD — fails until FEAT-647 implementation lands):
 * - Source label rendering from spell.kdl rules (project / user)
 * - Rule selector display in inspector
 * - Conflict banner for same-specificity rule collisions
 * - Backward-compat source labels when no rules match (frontmatter / settings)
 * - Loading placeholder during async rule resolution
 *
 * Edge cases:
 * - Long selector strings are truncated
 * - More than 5 conflicts collapse to "+N more"
 * - Missing ~/.spell/spell.kdl is handled gracefully
 */
import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { AgentDashboard } from "@spell/pi-coding-agent/modes/components/agent-dashboard";
import { getThemeByName, setThemeInstance } from "@spell/pi-coding-agent/modes/theme/theme";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(theme);
});

describe("AgentDashboard", () => {
	it("renders the agent control center header", async () => {
		const tempDir = path.join(os.tmpdir(), `spell-dashboard-test-${Date.now()}`);
		const settings = Settings.isolated();
		const dashboard = await AgentDashboard.create(tempDir, settings, 40);
		const lines = dashboard.render(100);
		const header = lines.find(l => l.includes("Agent Control Center"));
		expect(header).toBeDefined();
	});
	describe("wave-2: effective rule surfacing", () => {
		it("shows Source: spell.kdl (project) and rule selector when a project rule matches", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spell-dash-"));
			const agentsDir = path.join(tmp, ".spell", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await Bun.write(
				path.join(agentsDir, "explore.md"),
				"---\nname: explore\ndescription: Exploration agent\n---\n\nExplore the codebase.\n",
			);
			await Bun.write(
				path.join(tmp, "spell.kdl"),
				'agents {\n  rule "explore" {\n    model "anthropic/claude-haiku-4-5"\n  }\n}\n',
			);
			try {
				const settings = Settings.isolated();
				const dashboard = await AgentDashboard.create(tmp, settings, 40);
				const text = dashboard.render(160).map(stripAnsi).join("\n");
				expect(text).toContain("Source: spell.kdl (project)");
				expect(text).toContain("Rule: explore");
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it("truncates long selector strings in the inspector", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spell-dash-"));
			const agentsDir = path.join(tmp, ".spell", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await Bun.write(
				path.join(agentsDir, "explore.md"),
				"---\nname: explore\ndescription: Exploration agent\n---\n\nExplore the codebase.\n",
			);
			const longSelector = "explore-every-single-corner-of-this-very-large-codebase*";
			await Bun.write(
				path.join(tmp, "spell.kdl"),
				`agents {\n  rule "${longSelector}" {\n    model "anthropic/claude-haiku-4-5"\n  }\n}\n`,
			);
			try {
				const settings = Settings.isolated();
				const dashboard = await AgentDashboard.create(tmp, settings, 40);
				const lines = dashboard.render(160).map(stripAnsi);
				const ruleLine = lines.find(l => l.includes("Rule:"));
				expect(ruleLine).toBeDefined();
				expect(ruleLine!.length).toBeLessThanOrEqual(80);
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it("shows conflict banner when same-specificity rules collide", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spell-dash-"));
			const agentsDir = path.join(tmp, ".spell", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await Bun.write(
				path.join(agentsDir, "explore.md"),
				"---\nname: explore\ndescription: Exploration agent\n---\n\nExplore the codebase.\n",
			);
			await Bun.write(
				path.join(tmp, "spell.kdl"),
				'agents {\n  rule "expl*" {\n    model "anthropic/claude-haiku-4-5"\n  }\n  rule "explo*" {\n    model "openai/gpt-5-mini"\n  }\n}\n',
			);
			try {
				const settings = Settings.isolated();
				const dashboard = await AgentDashboard.create(tmp, settings, 40);
				const text = dashboard.render(160).map(stripAnsi).join("\n");
				expect(text).toMatch(/conflict|ambiguous|⚠/i);
				expect(text).toContain("expl*");
				expect(text).toContain("explo*");
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it("collapses more than 5 conflicts to +N more", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spell-dash-"));
			const agentsDir = path.join(tmp, ".spell", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await Bun.write(
				path.join(agentsDir, "explore.md"),
				"---\nname: explore\ndescription: Exploration agent\n---\n\nExplore the codebase.\n",
			);
			const rules: string[] = [];
			for (let i = 0; i < 7; i++) {
				rules.push(`  rule "expl*-${i}" {\n    model "openai/gpt-${i}"\n  }`);
			}
			await Bun.write(path.join(tmp, "spell.kdl"), `agents {\n${rules.join("\n")}\n}\n`);
			try {
				const settings = Settings.isolated();
				const dashboard = await AgentDashboard.create(tmp, settings, 40);
				const text = dashboard.render(160).map(stripAnsi).join("\n");
				expect(text).toMatch(/conflict|ambiguous|⚠/i);
				expect(text).toMatch(/\+\d+ more/);
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it("falls back to frontmatter source when no rules match", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spell-dash-"));
			const agentsDir = path.join(tmp, ".spell", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await Bun.write(
				path.join(agentsDir, "reviewer.md"),
				"---\nname: reviewer\ndescription: Review agent\nmodel:\n  - openai/gpt-5-mini\n---\n\nReview the code.\n",
			);
			try {
				const settings = Settings.isolated();
				const dashboard = await AgentDashboard.create(tmp, settings, 40);
				const text = dashboard.render(160).map(stripAnsi).join("\n");
				expect(text).toContain("Source: frontmatter");
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it("falls back to settings source when model comes from settings override", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spell-dash-"));
			const agentsDir = path.join(tmp, ".spell", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await Bun.write(
				path.join(agentsDir, "helper.md"),
				"---\nname: helper\ndescription: Helper agent\n---\n\nHelp out.\n",
			);
			try {
				const settings = Settings.isolated();
				settings.set("task.agentModelOverrides", { helper: "anthropic/claude-haiku-4-5" });
				const dashboard = await AgentDashboard.create(tmp, settings, 40);
				const text = dashboard.render(160).map(stripAnsi).join("\n");
				expect(text).toContain("Source: settings");
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it("handles missing user spell.kdl gracefully", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spell-dash-"));
			const agentsDir = path.join(tmp, ".spell", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await Bun.write(
				path.join(agentsDir, "test-agent.md"),
				"---\nname: test-agent\ndescription: Test agent\n---\n\nTest.\n",
			);
			try {
				const settings = Settings.isolated();
				const dashboard = await AgentDashboard.create(tmp, settings, 40);
				const lines = dashboard.render(160).map(stripAnsi);
				expect(lines.some(l => l.includes("Agent Control Center"))).toBe(true);
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it.todo("shows loading placeholder while rules are resolving", async () => {
			// Requires intercepting render during the async #reloadData window.
			// When FEAT-647 lands, verify a `loading rules…` line appears for
			// at least one frame before resolution completes.
		});
	});
});
