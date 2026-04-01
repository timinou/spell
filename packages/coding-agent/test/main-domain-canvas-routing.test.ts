import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import codingDomain from "../../../domain/coding/manifest";
import growthDomain from "../../../domain/growth/manifest";
import { loadDomain } from "../src/domain/loader";
import { buildQmlLaunchConfig } from "../src/modes/qml-mode";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

describe("domain canvas routing", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-domain-canvas-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("builds a growth shell launch config from the domain manifest payload", () => {
		const config = buildQmlLaunchConfig(REPO_ROOT, growthDomain);

		expect(config.title).toBe("Spell Growth");
		expect(config.shellPath).toBe(path.resolve(REPO_ROOT, growthDomain.shellQmlPath ?? ""));
		expect(config.workspaces).toEqual(growthDomain.workspaces);
		expect(config.panels[0]?.id).toBe("chat");
		expect(config.panels.some(panel => panel.id === "intel")).toBe(true);
		expect(config.panels.find(panel => panel.id === "intel")?.path).toBe(
			path.resolve(REPO_ROOT, "domain/growth/src/qml/panels/IntelPanel.qml"),
		);
	});

	it("resolves built-in growth canvas assets independently of the current working directory", async () => {
		const builtInGrowth = await loadDomain("growth", tempDir);
		const config = buildQmlLaunchConfig(tempDir, builtInGrowth);

		expect(config.shellPath).toBe(path.resolve(REPO_ROOT, growthDomain.shellQmlPath ?? ""));
		expect(config.panels.find(panel => panel.id === "intel")?.path).toBe(
			path.resolve(REPO_ROOT, "domain/growth/src/qml/panels/IntelPanel.qml"),
		);
	});

	it("keeps the default shell for coding domain", () => {
		const config = buildQmlLaunchConfig(REPO_ROOT, codingDomain);

		expect(config.title).toBe("Spell");
		expect(config.shellPath).toBe(path.resolve(REPO_ROOT, "packages/coding-agent/src/modes/qml/shell.qml"));
		expect(config.workspaces).toEqual([]);
	});
});
