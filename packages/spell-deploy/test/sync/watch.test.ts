import { describe, expect, it } from "bun:test";
import { parseDuration, WatchOrchestrator } from "../../src/sync/watch";
import type { WatchOptions } from "../../src/sync/watch-types";
import { shouldExclude } from "../../src/sync/watcher";

const watchOptions: WatchOptions = {
	target: {
		name: "production",
		host: "spell.example.com",
		user: "spell",
		port: 22,
		projectRoot: "/srv/spell/app",
		include: ["src/", "package.json"],
		exclude: ["node_modules/", ".git/"],
	},
	sync: {
		pushDebounce: "2s",
		pull: ["data/", "artifacts/"],
		pullInterval: "30s",
		sqliteBackup: true,
	},
	localRoot: "/workspace/app",
};

describe("parseDuration", () => {
	it("parses seconds", () => {
		expect(parseDuration("2s")).toBe(2000);
		expect(parseDuration("30s")).toBe(30_000);
	});

	it("parses milliseconds", () => {
		expect(parseDuration("500ms")).toBe(500);
	});

	it("parses minutes", () => {
		expect(parseDuration("5m")).toBe(300_000);
	});

	it("throws on invalid format", () => {
		expect(() => parseDuration("soon")).toThrow("Invalid duration: soon");
	});
});

describe("shouldExclude", () => {
	it("matches excluded directory prefixes with or without trailing slash", () => {
		expect(shouldExclude("node_modules/pkg/index.js", ["node_modules/"])).toBe(true);
		expect(shouldExclude(".git/config", [".git"])).toBe(true);
		expect(shouldExclude("src/index.ts", ["node_modules/", ".git/"])).toBe(false);
	});

	it("matches exact directory names", () => {
		expect(shouldExclude("node_modules", ["node_modules/"])).toBe(true);
		expect(shouldExclude(".git", [".git/"])).toBe(true);
	});
});

describe("WatchOrchestrator", () => {
	it("accepts valid options in the constructor", () => {
		const orchestrator = new WatchOrchestrator(watchOptions);

		expect(orchestrator).toBeInstanceOf(WatchOrchestrator);
	});

	it("exposes the correct initial state", () => {
		const orchestrator = new WatchOrchestrator(watchOptions);

		expect(orchestrator.state).toEqual({
			running: false,
			pushCount: 0,
			pullCount: 0,
		});
	});
});
