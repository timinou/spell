/**
 * Thin stateful wrapper over QmlTestHarness that reads like user journey scripts.
 * Provides semantic methods (agentSends, expectVisible, click) that map directly
 * to user story language.
 */
import * as path from "node:path";
import {
	isBridgeAvailable,
	type ObservationEntry,
	QmlTestHarness,
	type QueryItem,
	type QuerySelector,
} from "@oh-my-pi/pi-qml";

const QML_ROOT = path.resolve(import.meta.dir, "../../src/modes/qml");

export class QmlJourney {
	#harness: QmlTestHarness;
	#settleMs: number;
	#assertTimeout: number;

	constructor(harness: QmlTestHarness, settleMs = 50, assertTimeout = 2000) {
		this.#harness = harness;
		this.#settleMs = settleMs;
		this.#assertTimeout = assertTimeout;
	}

	static async launch(
		qmlFile: string,
		options?: {
			props?: Record<string, unknown>;
			width?: number;
			height?: number;
			settleMs?: number;
			assertTimeout?: number;
		},
	): Promise<QmlJourney> {
		const harness = new QmlTestHarness({
			width: options?.width ?? 1280,
			height: options?.height ?? 800,
		});
		await harness.setup(path.resolve(QML_ROOT, qmlFile), options?.props);
		return new QmlJourney(harness, options?.settleMs ?? 50, options?.assertTimeout ?? 2000);
	}

	// -- Agent simulation: things the agent sends to QML --

	async agentSends(payload: Record<string, unknown>): Promise<void> {
		await this.#harness.sendMessage(payload);
		await this.#harness.settle(this.#settleMs);
	}

	// -- User simulation: things the human does --

	async click(selector: QuerySelector): Promise<void> {
		await this.#harness.click(selector);
		await this.#harness.settle(this.#settleMs);
	}

	async clickAt(x: number, y: number): Promise<void> {
		await this.#harness.clickAt(x, y);
		await this.#harness.settle(this.#settleMs);
	}

	async clickId(id: number): Promise<void> {
		await this.#harness.clickId(id);
		await this.#harness.settle(this.#settleMs);
	}

	async type(text: string, selector?: QuerySelector): Promise<void> {
		await this.#harness.type(text, selector);
		await this.#harness.settle(this.#settleMs);
	}

	async press(key: string): Promise<void> {
		await this.#harness.press(key);
		await this.#harness.settle(this.#settleMs);
	}

	async scroll(selector: QuerySelector, deltaY: number): Promise<void> {
		const items = await this.#harness.findItems(selector, { includeGeometry: true });
		if (items.length === 0) {
			throw new Error(`scroll: no element found matching ${JSON.stringify(selector)}`);
		}
		const item = items[0];
		const sp = item.scenePosition ?? { x: item.geometry!.x, y: item.geometry!.y };
		const cx = sp.x + item.geometry!.width / 2;
		const cy = sp.y + item.geometry!.height / 2;
		await this.#harness.scroll(cx, cy, deltaY);
		await this.#harness.settle(this.#settleMs);
	}

	async observe(): Promise<ObservationEntry[]> {
		return this.#harness.observe();
	}

	// -- Assertions: verify visual state --

	async expectVisible(selector: QuerySelector, timeout?: number): Promise<QueryItem> {
		return this.#harness.waitUntil(async () => {
			const items = await this.#harness.findItems(selector, { includeGeometry: true });
			const item = items[0];
			if (!item || !item.visible) {
				return null;
			}
			if ((item.geometry?.width ?? 0) <= 0 || (item.geometry?.height ?? 0) <= 0) {
				return null;
			}
			return item;
		}, timeout ?? this.#assertTimeout);
	}

	async expectNotFound(selector: QuerySelector): Promise<void> {
		await this.#harness.settle(this.#settleMs);
		const items = await this.#harness.findItems(selector);
		if (items.length > 0) {
			throw new Error(
				`expectNotFound: expected no elements matching ${JSON.stringify(selector)}, found ${items.length}`,
			);
		}
	}

	async expectText(text: string, timeout?: number): Promise<void> {
		await this.#harness.waitUntil(async () => {
			const texts = await this.#harness.findVisibleText();
			return texts.some(t => t.includes(text)) || null;
		}, timeout ?? this.#assertTimeout);
	}

	async expectTextAbsent(text: string): Promise<void> {
		await this.#harness.settle(this.#settleMs);
		const texts = await this.#harness.findVisibleText();
		if (texts.some(t => t.includes(text))) {
			throw new Error(`expectTextAbsent: "${text}" was found in visible text`);
		}
	}

	async switchPanel(id: string): Promise<void> {
		const idx = await this.evaluate<number>(`root.findPanelIndexById('${id}')`);
		if (idx < 0) {
			throw new Error(`switchPanel: panel '${id}' not found`);
		}
		await this.evaluate(`root.activePanelIndex = ${idx}`);
		await this.#harness.settle(this.#settleMs);
	}

	async panelProperty<T>(name: string): Promise<T> {
		return this.evaluate<T>(`root.getActivePanelItem().${name}`);
	}

	// -- Input helpers --

	/** Focus the TextEdit inside the active panel's InputBar via observe()+clickId(). */
	async focusInput(): Promise<void> {
		const elements = await this.observe();
		const textEdit = elements.find(e => e.className.startsWith("QQuickTextEdit"));
		if (textEdit) {
			await this.clickId(textEdit.id);
			return;
		}
		const flickable = elements.find(e => e.className.startsWith("QQuickFlickable"));
		if (!flickable) throw new Error("No TextEdit or Flickable found for input focus");
		await this.clickId(flickable.id);
	}

	/**
	 * Type a message and press Return. Sets up event listener BEFORE pressing Return
	 * to avoid race. Returns the captured prompt payload.
	 */
	async submitPrompt(text: string): Promise<Record<string, unknown>> {
		await this.focusInput();
		await this.#harness.type(text);
		await this.#harness.settle(this.#settleMs);
		const eventPromise = this.#harness.waitForBridgeEvent(
			e =>
				e.type === "event" && (e as { type: "event"; payload: Record<string, unknown> }).payload?.type === "prompt",
			5000,
		);
		await this.#harness.press("Return");
		const ev = await eventPromise;
		await this.#harness.settle(this.#settleMs);
		return (ev as { type: "event"; payload: Record<string, unknown> }).payload;
	}

	/** Send a simulated tool response back to QML for a pending _rid request. */
	async simulateToolResponse(rid: string, payload: Record<string, unknown>): Promise<void> {
		await this.#harness.simulateToolResponse(rid, payload);
		await this.#harness.settle(this.#settleMs);
	}

	// -- Assertions: panel state --

	/** Retry-based assertion that the active panel has the expected id. */
	async expectPanelActive(id: string): Promise<void> {
		await this.#harness.waitUntil(async () => {
			const activeId = await this.evaluate<string>("root.activePanelId()");
			return activeId === id || null;
		}, this.#assertTimeout);
	}

	// -- Utilities --

	/** Expose harness waitUntil for custom retry-based assertions and resetShell. */
	async waitUntil<T>(fn: () => Promise<T | null | false>, timeout?: number): Promise<T> {
		return this.#harness.waitUntil(fn, timeout ?? this.#assertTimeout);
	}

	async settle(delayMs?: number): Promise<void> {
		await this.#harness.settle(delayMs);
	}

	async screenshot(name: string): Promise<string> {
		const dir = path.resolve(import.meta.dir, "../integration/screenshots");
		return this.#harness.screenshot(path.join(dir, name));
	}

	async findItems(...args: Parameters<QmlTestHarness["findItems"]>): Promise<QueryItem[]> {
		return this.#harness.findItems(...args);
	}

	async evaluate<T>(expression: string): Promise<T> {
		return this.#harness.evaluate<T>(expression);
	}

	async waitForEvent(
		predicate: (event: Record<string, unknown>) => boolean,
		timeout?: number,
	): Promise<Record<string, unknown>> {
		const event = await this.#harness.waitForBridgeEvent(
			e => predicate(e as unknown as Record<string, unknown>),
			timeout,
		);
		return event as unknown as Record<string, unknown>;
	}

	async teardown(): Promise<void> {
		await this.#harness.teardown();
	}
}

export { isBridgeAvailable };

/**
 * Reset shell.qml state between tests when sharing a QmlJourney instance.
 * Only works when resetting TO chat panel (index 0, ChatPanel.qml).
 * Waits for Loader to finish loading before clearing state.
 */
export async function resetShell(journey: QmlJourney): Promise<void> {
	await journey.evaluate("root.activePanelIndex = 0");
	await journey.waitUntil(async () => {
		const hasItem = await journey.evaluate<boolean>(
			"root.getActivePanelItem() !== null && typeof root.getActivePanelItem().messagesModel !== 'undefined'",
		);
		return hasItem || null;
	}, 2000);
	await journey.evaluate("root.getActivePanelItem().messagesModel.clear()");
	await journey.evaluate("root.getActivePanelItem().isStreaming = false");
	await journey.evaluate("root.pendingPanelMessages = ({})");
	await journey.settle(50);
}
