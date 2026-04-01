import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import codingDomain from "../../../domain/coding/manifest";
import growthDomain from "../../../domain/growth/manifest";
import { shouldAutoLaunchDomainCanvas } from "../src/main";
import { buildQmlLaunchConfig } from "../src/modes/qml-mode";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

describe("domain canvas routing", () => {
	it("auto-launches a domain canvas only for interactive always-canvas sessions", () => {
		expect(shouldAutoLaunchDomainCanvas(true, { canvas: undefined }, growthDomain)).toBe(true);
		expect(shouldAutoLaunchDomainCanvas(false, { canvas: undefined }, growthDomain)).toBe(false);
		expect(shouldAutoLaunchDomainCanvas(true, { canvas: "browse" }, growthDomain)).toBe(false);
		expect(shouldAutoLaunchDomainCanvas(true, { canvas: undefined }, codingDomain)).toBe(false);
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

	it("keeps the default shell for non-canvas domains", () => {
		const config = buildQmlLaunchConfig(REPO_ROOT, codingDomain);

		expect(config.title).toBe("Spell");
		expect(config.shellPath).toBe(path.resolve(REPO_ROOT, "packages/coding-agent/src/modes/qml/shell.qml"));
		expect(config.workspaces).toEqual([]);
	});
});
