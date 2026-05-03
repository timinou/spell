import { describe, expect, it } from "bun:test";

import {
	EXCLUDED_FROM_KDL,
	findSettingPath,
	getAllBlocks,
	getKdlMapping,
	getMappingsForBlock,
	KDL_SETTINGS_MAP,
} from "../../src/config/kdl-settings-map";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";

describe("KDL_SETTINGS_MAP coverage", () => {
	it("every SettingPath is either mapped or excluded", () => {
		const allPaths = Object.keys(SETTINGS_SCHEMA);
		const unmapped = allPaths.filter(
			p => !(KDL_SETTINGS_MAP as Record<string, unknown>)[p] && !EXCLUDED_FROM_KDL.has(p),
		);
		expect(unmapped).toEqual([]);
	});

	it("no mapping exists for paths outside SETTINGS_SCHEMA", () => {
		const allPaths = new Set(Object.keys(SETTINGS_SCHEMA));
		const extraMapped = Object.keys(KDL_SETTINGS_MAP).filter(
			k => (KDL_SETTINGS_MAP as Record<string, unknown>)[k] && !allPaths.has(k),
		);
		expect(extraMapped).toEqual([]);
	});

	it("no path is both mapped and excluded", () => {
		const both = Object.keys(KDL_SETTINGS_MAP).filter(
			k => (KDL_SETTINGS_MAP as Record<string, unknown>)[k] && EXCLUDED_FROM_KDL.has(k),
		);
		expect(both).toEqual([]);
	});
});

describe("getKdlMapping", () => {
	it("returns mapping for theme.dark", () => {
		const mapping = getKdlMapping("theme.dark");
		expect(mapping).toEqual({
			block: "appearance",
			nodePath: "theme",
			accessor: "property",
			propertyName: "dark",
		});
	});

	it("returns mapping for compaction.enabled", () => {
		const mapping = getKdlMapping("compaction.enabled");
		expect(mapping).toEqual({
			block: "model",
			nodePath: "compaction",
			accessor: "property",
			propertyName: "enabled",
		});
	});

	it("returns mapping for defaultThinkingLevel (argument accessor)", () => {
		const mapping = getKdlMapping("defaultThinkingLevel");
		expect(mapping).toEqual({
			block: "model",
			nodePath: "thinking",
			accessor: "argument",
		});
	});

	it("returns undefined for excluded path", () => {
		expect(getKdlMapping("lastChangelogVersion")).toBeUndefined();
	});

	it("returns undefined for unknown path", () => {
		expect(getKdlMapping("nonexistent.path")).toBeUndefined();
	});
});

describe("findSettingPath", () => {
	it("finds appearance/symbols → symbolPreset", () => {
		expect(findSettingPath("appearance", "symbols")).toBe("symbolPreset");
	});

	it("finds model/compaction/enabled → compaction.enabled", () => {
		expect(findSettingPath("model", "compaction", "enabled")).toBe("compaction.enabled");
	});

	it("finds appearance/theme/dark → theme.dark", () => {
		expect(findSettingPath("appearance", "theme", "dark")).toBe("theme.dark");
	});

	it("returns undefined for nonexistent", () => {
		expect(findSettingPath("nonexistent", "node")).toBeUndefined();
	});
});

describe("getAllBlocks", () => {
	it("returns all block names", () => {
		const blocks = getAllBlocks();
		expect(blocks).toContain("appearance");
		expect(blocks).toContain("model");
		expect(blocks).toContain("interaction");
		expect(blocks).toContain("tools");
		expect(blocks).toContain("tasks");
		expect(blocks).toContain("skills");
		expect(blocks).toContain("org");
		expect(blocks).toContain("providers");
	});
});

describe("getMappingsForBlock", () => {
	it("returns all appearance mappings", () => {
		const mappings = getMappingsForBlock("appearance");
		const paths = mappings.map(([path]) => path);
		expect(paths).toContain("theme.dark");
		expect(paths).toContain("theme.light");
		expect(paths).toContain("symbolPreset");
	});

	it("returns empty for unknown block", () => {
		expect(getMappingsForBlock("nonexistent")).toEqual([]);
	});
});
