import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const BROWSE_SHELL_QML = "BrowseShell.qml";
const tempDirs: string[] = [];

async function createSettingsPath(): Promise<{ settingsFile: string; settingsCategory: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "browse-persist-"));
	tempDirs.push(dir);
	return {
		settingsFile: path.join(dir, "browse.ini"),
		settingsCategory: `BrowsePersist-${Date.now()}-${Math.floor(Math.random() * 100_000)}`,
	};
}

async function launchShell(props: Record<string, unknown>): Promise<QmlJourney> {
	return QmlJourney.launch(BROWSE_SHELL_QML, {
		props: { model: "test-provider/test-model", ...props },
		width: 1360,
		height: 900,
		settleMs: 100,
		assertTimeout: 5_000,
	});
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
});

describe.skipIf(!isBridgeAvailable())("Browse tab persistence", () => {
	it("saves open tab state and restores it on relaunch", async () => {
		const settings = await createSettingsPath();

		const firstJourney = await launchShell(settings);
		try {
			await firstJourney.agentSends({
				action: "tab:open",
				tabId: "research-1",
				title: "First tab",
				url: "https://example.com/one",
			});
			await firstJourney.agentSends({
				action: "tab:open",
				tabId: "research-2",
				title: "Second tab",
				url: "https://example.com/two",
			});
			await firstJourney.settle(250);
		} finally {
			await firstJourney.teardown();
		}

		const persisted = await fs.readFile(settings.settingsFile, "utf8");
		expect(persisted).toContain("https://example.com/one");
		expect(persisted).toContain("https://example.com/two");

		const resumedJourney = await launchShell(settings);
		try {
			await resumedJourney.waitUntil(async () => {
				return (await resumedJourney.evaluate<number>("root.browserTabCount()")) === 2 || null;
			}, 5_000);
			expect(await resumedJourney.evaluate<number>("root.browserTabCount()")).toBe(2);
			expect(await resumedJourney.evaluate<string>("root.activeTabId()")).toBe("research-2");
			await resumedJourney.expectText("First tab");
			await resumedJourney.expectText("Second tab");
		} finally {
			await resumedJourney.teardown();
		}
	}, 10_000);

	it("restores tabs from launch props", async () => {
		const settings = await createSettingsPath();
		const journey = await launchShell({
			...settings,
			restoreTabs: [
				{ tabId: "restored-1", title: "Restored one", url: "https://example.com/restored-one" },
				{ tabId: "restored-2", title: "Restored two", url: "https://example.com/restored-two" },
			],
			restoreActiveTabId: "restored-2",
		});

		try {
			await journey.waitUntil(async () => {
				return (await journey.evaluate<number>("root.browserTabCount()")) === 2 || null;
			}, 5_000);
			expect(await journey.evaluate<number>("root.browserTabCount()")).toBe(2);
			expect(await journey.evaluate<string>("root.activeTabId()")).toBe("restored-2");
			await journey.expectText("Restored one");
			await journey.expectText("Restored two");
		} finally {
			await journey.teardown();
		}
	}, 10_000);
});
