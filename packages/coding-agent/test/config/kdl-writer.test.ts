import { describe, expect, it } from "bun:test";

import { format, parse } from "@bgotink/kdl";

import { applySettingsToKdl, writeKdlSettings } from "../../src/config/kdl-writer";

function normalized(text: string): string {
	return text.trim().replaceAll(/\r\n/g, "\n");
}

describe("applySettingsToKdl", () => {
	it("applies a single setting change", () => {
		const doc = parse('model { thinking "low" }');
		applySettingsToKdl(doc, new Map([["defaultThinkingLevel", "high"]]));

		expect(normalized(format(doc))).toContain("model { thinking high }");
	});

	it("preserves comments and formatting on existing documents", () => {
		const doc = parse(`// heading
model {
    // keep this
    retry enabled=#false max=1
}`);
		applySettingsToKdl(doc, new Map([["retry.enabled", true]]));

		const out = normalized(format(doc));
		expect(out).toContain("// heading");
		expect(out).toContain("// keep this");
		expect(out).toContain("retry enabled=#true max=1");
	});

	it("creates new blocks and nested nodes", () => {
		const doc = parse("");
		applySettingsToKdl(
			doc,
			new Map<string, unknown>([
				["tools.intentTracing", true],
				["temperature", 0.5],
			]),
		);

		const out = normalized(format(doc));
		expect(out).toContain("tools {");
		expect(out).toContain("intent-tracing #true");
		expect(out).toContain("model {");
		expect(out).toContain("sampling {");
		expect(out).toContain("temperature 0.5");
	});

	it("writes canonical tree records for migrated settings", () => {
		const doc = parse(`
model { roles { legacy "old" } }
tasks { agent-model-overrides { legacy "old" } }
plan-mode { allowed-folders { folder "./old" description="Old" } }
appearance { status-line { segment-options { git enabled=#true } } }
`);
		applySettingsToKdl(
			doc,
			new Map<string, unknown>([
				["modelRoles", { default: "anthropic/claude-sonnet-4-20250514", task: "anthropic/claude-haiku-3" }],
				["task.agentModelOverrides", { main: "anthropic/claude-sonnet-4-20250514" }],
				["planMode.allowedFolders", { "./plans": "Plan folder" }],
				["statusLine.segmentOptions", { git: { enabled: true, compact: false } }],
			]),
		);

		const out = normalized(format(doc));
		expect(out).toContain(
			'roles {\n\t\tdefault "anthropic/claude-sonnet-4-20250514"\n\t\ttask "anthropic/claude-haiku-3"\n\t}',
		);
		expect(out).toContain('agent-model-overrides {\n\t\tmain "anthropic/claude-sonnet-4-20250514"\n\t}');
		expect(out).toContain('allowed-folders {\n\t\tfolder "./plans" description="Plan folder"\n\t}');
		expect(out).toContain("segment-options {");
	});

	it("returns the same document for empty changes", () => {
		const doc = parse("tools { intent-tracing #true }");
		const before = normalized(format(doc));
		const result = applySettingsToKdl(doc, new Map());
		expect(result).toBe(doc);
		expect(normalized(format(result))).toBe(before);
	});
});

describe("writeKdlSettings", () => {
	it("creates a new file when missing and round-trips valid KDL", async () => {
		const filePath = `${Bun.env.TMPDIR ?? "/tmp"}/spell-kdl-writer-${crypto.randomUUID()}.kdl`;
		await writeKdlSettings(filePath, new Map([["task.autoRoster", true]]));

		const written = await Bun.file(filePath).text();
		const doc = parse(written);
		expect(normalized(format(doc))).toContain("tasks {\n\tauto-roster #true\n}");
	});
});
