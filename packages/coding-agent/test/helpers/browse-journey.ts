import { isBridgeAvailable, QmlJourney } from "./qml-journey";

export interface BrowseJourneyLaunchOptions {
	props?: Record<string, unknown>;
	width?: number;
	height?: number;
	settleMs?: number;
	assertTimeout?: number;
}

export interface BrowseFindingInput {
	id?: string;
	url: string;
	title: string;
	excerpt?: string;
	tags?: string[];
	tabId?: string;
	timestamp?: number;
	sourceType?: string;
	curated?: boolean;
	contentBody?: string;
}

export interface ViewInTabEventPayload {
	type?: string;
	tabId?: string;
	url?: string;
	title?: string;
}

function randomId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
}

export class BrowseJourney {
	#journey: QmlJourney;
	#ridCounter = 0;

	constructor(journey: QmlJourney) {
		this.#journey = journey;
	}

	static async launch(options?: BrowseJourneyLaunchOptions): Promise<BrowseJourney> {
		const settingsCategory = (options?.props?.settingsCategory as string | undefined) ?? randomId("browse-journey");
		const journey = await QmlJourney.launch("BrowseShell.qml", {
			props: { model: "test-provider/test-model", settingsCategory, ...(options?.props ?? {}) },
			width: options?.width ?? 1360,
			height: options?.height ?? 900,
			settleMs: options?.settleMs ?? 100,
			assertTimeout: options?.assertTimeout ?? 5_000,
		});
		return new BrowseJourney(journey);
	}

	async waitForProtocolResult(action: string, rid: string, timeout = 10_000): Promise<Record<string, unknown>> {
		const event = await this.#journey.waitForEvent(raw => {
			if (raw.type !== "event") return false;
			const payload = raw.payload as { action?: string; _rid?: string } | undefined;
			return payload?.action === action && payload._rid === rid;
		}, timeout);
		return event.payload as Record<string, unknown>;
	}

	async openTab(url: string, options?: { tabId?: string; title?: string; timeout?: number }): Promise<string> {
		const tabId = options?.tabId ?? randomId("browse-tab");
		const rid = `tab-open-${++this.#ridCounter}`;
		const resultPromise = this.waitForProtocolResult("tab:result", rid, options?.timeout ?? 10_000);
		await this.#journey.agentSends({
			action: "tab:open",
			_rid: rid,
			tabId,
			title: options?.title ?? url,
			url,
		});
		const result = resultPromise;
		const payload = await result;
		if (payload.ok === false) {
			throw new Error(`tab:open failed for ${tabId}`);
		}
		return tabId;
	}

	async closeTab(tabId: string, timeout = 10_000): Promise<void> {
		const rid = `tab-close-${++this.#ridCounter}`;
		const resultPromise = this.waitForProtocolResult("tab:result", rid, timeout);
		await this.#journey.agentSends({ action: "tab:close", _rid: rid, tabId });
		const payload = await resultPromise;
		if (payload.ok === false) {
			throw new Error(`tab:close failed for ${tabId}`);
		}
	}

	async switchToChat(): Promise<void> {
		await this.#journey.click({ objectName: "browseTab-chat", visible: true });
	}

	async switchToTab(tabId: string): Promise<void> {
		await this.#journey.click({ objectName: `browseTab-${tabId}`, visible: true });
	}

	async expectActiveTab(tabId: string): Promise<void> {
		await this.#journey.waitUntil(async () => {
			return (await this.#journey.evaluate<string>("root.activeTabId()")) === tabId || null;
		}, 5_000);
	}

	async sendFinding(finding: BrowseFindingInput): Promise<void> {
		await this.#journey.agentSends({
			type: "finding",
			id: finding.id ?? randomId("finding"),
			url: finding.url,
			title: finding.title,
			excerpt: finding.excerpt ?? "",
			tags: finding.tags ?? [],
			tabId: finding.tabId ?? "",
			timestamp: finding.timestamp ?? Date.now(),
		});
	}

	async expectTabCount(count: number): Promise<void> {
		await this.#journey.waitUntil(async () => {
			return (await this.#journey.evaluate<number>("root.browserTabCount()")) === count || null;
		}, 5_000);
	}

	async expectFindingCard(title: string): Promise<void> {
		await this.switchToChat();
		await this.#journey.expectVisible({ objectName: "findingCard", visible: true });
		await this.#journey.expectText(title);
	}

	async clickFindingViewInTab(timeout = 5_000): Promise<ViewInTabEventPayload> {
		const eventPromise = this.#journey.waitForEvent(raw => {
			if (raw.type !== "event") return false;
			const payload = raw.payload as ViewInTabEventPayload | undefined;
			return payload?.type === "view_in_tab";
		}, timeout);
		await this.#journey.click({ objectName: "viewInTabButton", visible: true });
		const event = await eventPromise;
		return event.payload as ViewInTabEventPayload;
	}

	async settle(delayMs?: number): Promise<void> {
		await this.#journey.settle(delayMs);
	}

	async evaluate<T>(expression: string): Promise<T> {
		return this.#journey.evaluate<T>(expression);
	}

	async waitUntil<T>(fn: () => Promise<T | null | false>, timeout?: number): Promise<T> {
		return this.#journey.waitUntil(fn, timeout);
	}

	async screenshot(name: string): Promise<string> {
		return this.#journey.screenshot(name);
	}

	async sendSearchBatch(query: string, sources: BrowseFindingInput[]): Promise<void> {
		const findings = sources.map(s => ({
			id: s.id ?? randomId("finding"),
			url: s.url,
			title: s.title,
			excerpt: s.excerpt ?? "",
			tags: s.tags ?? [],
			tabId: s.tabId ?? "",
			timestamp: s.timestamp ?? Date.now(),
			sourceType: s.sourceType ?? "search",
			curated: s.curated ?? false,
			enriched: false,
		}));
		await this.#journey.agentSends({
			type: "findings_batch",
			findings,
			searchGroup: { query, toolCallId: randomId("call") },
		});
	}

	async sendFetchFinding(url: string, title: string, contentBody?: string): Promise<void> {
		await this.#journey.agentSends({
			type: "findings_batch",
			findings: [
				{
					id: randomId("finding"),
					url,
					title,
					excerpt: "",
					tags: [],
					tabId: "",
					timestamp: Date.now(),
					sourceType: "fetch",
					curated: false,
					enriched: false,
					contentBody: contentBody ?? "",
				},
			],
			searchGroup: null,
		});
	}

	async expectFindingsCount(count: number): Promise<void> {
		await this.#journey.waitUntil(async () => {
			return (await this.#journey.evaluate<number>("root.findingsCount")) === count || null;
		}, 5_000);
	}

	async openFindingsDrawer(): Promise<void> {
		const isOpen = await this.#journey.evaluate<boolean>("root.findingsDrawerOpen");
		if (!isOpen) {
			await this.#journey.click({ objectName: "findingsToggleButton", visible: true });
			await this.#journey.waitUntil(async () => {
				return (await this.#journey.evaluate<boolean>("root.findingsDrawerOpen")) || null;
			}, 5_000);
		}
	}

	async expectFindingsPanelCount(count: number): Promise<void> {
		await this.#journey.waitUntil(async () => {
			return (await this.#journey.evaluate<number>("root.getFindingsPanelItem().findingCount()")) === count || null;
		}, 5_000);
	}

	async teardown(): Promise<void> {
		await this.#journey.teardown();
	}
}

export { isBridgeAvailable };
