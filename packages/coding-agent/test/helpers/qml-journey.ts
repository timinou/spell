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

	constructor(harness: QmlTestHarness) {
		this.#harness = harness;
	}

	static async launch(
		qmlFile: string,
		options?: { props?: Record<string, unknown>; width?: number; height?: number },
	): Promise<QmlJourney> {
		const harness = new QmlTestHarness({
			width: options?.width ?? 1280,
			height: options?.height ?? 800,
		});
		await harness.setup(path.resolve(QML_ROOT, qmlFile), options?.props);
		return new QmlJourney(harness);
	}

	// -- Agent simulation: things the agent sends to QML --

	async agentSends(payload: Record<string, unknown>): Promise<void> {
		await this.#harness.sendMessage(payload);
	}

	// -- User simulation: things the human does --

	async click(selector: QuerySelector): Promise<void> {
		await this.#harness.click(selector);
	}

	async clickAt(x: number, y: number): Promise<void> {
		await this.#harness.clickAt(x, y);
	}

	async clickId(id: number): Promise<void> {
		await this.#harness.clickId(id);
	}

	async type(text: string, selector?: QuerySelector): Promise<void> {
		await this.#harness.type(text, selector);
	}

	async press(key: string): Promise<void> {
		await this.#harness.press(key);
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
	}

	async observe(): Promise<ObservationEntry[]> {
		return this.#harness.observe();
	}

	// -- Assertions: verify visual state --

	async expectVisible(selector: QuerySelector): Promise<QueryItem> {
		return this.#harness.assertVisible(selector);
	}

	async expectNotFound(selector: QuerySelector): Promise<void> {
		await this.#harness.assertNotFound(selector);
	}

	async expectText(text: string): Promise<void> {
		const texts = await this.#harness.findVisibleText();
		if (!texts.some(t => t.includes(text))) {
			throw new Error(`expectText: "${text}" not found in visible text. Found: ${texts.join(", ")}`);
		}
	}

	async expectTextAbsent(text: string): Promise<void> {
		const texts = await this.#harness.findVisibleText();
		if (texts.some(t => t.includes(text))) {
			throw new Error(`expectTextAbsent: "${text}" was found in visible text`);
		}
	}

	// -- Utilities --

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
