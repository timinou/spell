import { describe, expect, it } from "bun:test";
import { parse } from "@bgotink/kdl";

import { kdlDocumentToSettings, loadKdlSettings } from "../../src/config/kdl-reader";

const COMPLETE_KDL = `
appearance {
	theme dark="titanium" light="light"
	symbols "unicode"
	color-blind #false
	status-line preset="default" separator="powerline-thin" {
		left "pi" "model" "plan_mode" "path" "git"
		right "token_total" "cost" "context_pct" "time"
		show-hook-status #true
	}
	images show-inline=#true auto-resize=#true
}

model {
	thinking "high"
	roles {
		default "anthropic/claude-sonnet-4-20250514"
	}
	sampling {
		temperature 0.5
		top-p 0.9
	}
	retry enabled=#true max=3
	compaction enabled=#true strategy="context-full"
}

tasks {
	eager #false
	auto-roster #true
	max-concurrency 32
	max-recursion 2
	disabled-agents "legacy" "bot"
	agent-model-overrides {
		main "anthropic/claude-sonnet-4-20250514"
		helper "anthropic/claude-haiku-3"
	}
}

plan-mode {
	allowed-folders {
		folder "./plans" description="Plan folder"
	}
}
`;

const PARTIAL_KDL = `
appearance {
	symbols "ascii"
}
`;

async function writeTempFile(name: string, content: string): Promise<string> {
	const path = `/tmp/${name}-${crypto.randomUUID()}.kdl`;
	await Bun.write(path, content);
	return path;
}

describe("kdlDocumentToSettings", () => {
	it("parses a complete KDL document", () => {
		const settings = kdlDocumentToSettings(parse(COMPLETE_KDL));

		expect(settings).toMatchObject({
			theme: { dark: "titanium", light: "light" },
			symbolPreset: "unicode",
			colorBlindMode: false,
			statusLine: {
				preset: "default",
				separator: "powerline-thin",
				showHookStatus: true,
				leftSegments: ["pi", "model", "plan_mode", "path", "git"],
				rightSegments: ["token_total", "cost", "context_pct", "time"],
			},
			terminal: { showImages: true },
			images: { autoResize: true },
			defaultThinkingLevel: "high",
			temperature: 0.5,
			topP: 0.9,
			compaction: { enabled: true, strategy: "context-full" },
			retry: { enabled: true, maxRetries: 3 },
			task: {
				eager: false,
				autoRoster: true,
				maxConcurrency: 32,
				maxRecursionDepth: 2,
				disabledAgents: ["legacy", "bot"],
				agentModelOverrides: { main: "anthropic/claude-sonnet-4-20250514", helper: "anthropic/claude-haiku-3" },
			},
			planMode: { allowedFolders: { "./plans": "Plan folder" } },
			modelRoles: { default: "anthropic/claude-sonnet-4-20250514" },
		});
	});

	it("parses a partial document", () => {
		const settings = kdlDocumentToSettings(parse(PARTIAL_KDL));
		expect(settings).toEqual({ symbolPreset: "ascii" });
	});

	it("returns empty object for empty document", () => {
		expect(kdlDocumentToSettings(parse(""))).toEqual({});
	});

	it("skips missing blocks and nodes", () => {
		const settings = kdlDocumentToSettings(parse('model { thinking "high" }'));
		expect(settings).toEqual({ defaultThinkingLevel: "high" });
	});

	it("handles nested node paths", () => {
		const settings = kdlDocumentToSettings(
			parse(`
model {
	sampling {
		temperature 0.75
	}
}
interaction {
	context {
		promotion enabled=#true
	}
}
`),
		);
		expect(settings).toEqual({ temperature: 0.75, contextPromotion: { enabled: true } });
	});

	it("reads canonical tree records and preserves unknown siblings", () => {
		const settings = kdlDocumentToSettings(
			parse(`
model {
	// keep me
	roles {
		default "a"
		custom "b"
		unknown "c"
	}
}
tasks {
	agent-model-overrides {
		main "x"
		helper "y"
	}
}
plan-mode {
	allowed-folders {
		folder "./one" description="One"
		folder "./two" description="Two"
		unknown-node "keep"
	}
}
`),
		);

		expect(settings).toMatchObject({
			modelRoles: { default: "a", custom: "b", unknown: "c" },
			task: { agentModelOverrides: { main: "x", helper: "y" } },
			planMode: { allowedFolders: { "./one": "One", "./two": "Two" } },
		});
	});
});

describe("loadKdlSettings", () => {
	it("returns empty object for nonexistent file", async () => {
		await expect(loadKdlSettings(`/tmp/does-not-exist-${crypto.randomUUID()}.kdl`)).resolves.toEqual({});
	});

	it("returns empty object for invalid KDL", async () => {
		const filePath = await writeTempFile("invalid-kdl", 'appearance { theme dark="x"');
		await expect(loadKdlSettings(filePath)).resolves.toEqual({});
	});
});
