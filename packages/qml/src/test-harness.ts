import * as os from "node:os";
import * as path from "node:path";
import type { BridgeEvent } from "./protocol";
import { isBridgeAvailable, QmlProcess } from "./qml-process";

export interface QuerySelector {
	type?: string;
	objectName?: string;
	visible?: boolean;
	textContains?: string;
}

export interface QueryItem {
	className: string;
	objectName: string;
	geometry?: { x: number; y: number; width: number; height: number };
	scenePosition?: { x: number; y: number };
	visible: boolean;
	opacity: number;
	enabled: boolean;
	clip: boolean;
	properties: Record<string, unknown>;
	childCount: number;
	path: string;
}

export interface ObservationEntry {
	id: number;
	className: string;
	objectName: string;
	text?: string;
	geometry: { x: number; y: number; width: number; height: number };
	scenePosition: { x: number; y: number };
	enabled: boolean;
	visible: boolean;
}

export interface QmlTestHarnessOptions {
	/** Additional env vars beyond QT_QPA_PLATFORM=offscreen */
	env?: Record<string, string>;
	width?: number;
	height?: number;
}

const TEST_WINDOW_ID = "test";

/**
 * High-level test helper for QML integration tests.
 * Wraps QmlProcess in stdio mode with offscreen rendering so tests
 * can exercise the full JS→bridge→QML→bridge→JS event loop headlessly.
 *
 * Usage pattern:
 *   const harness = new QmlTestHarness();
 *   await harness.setup(path.resolve("ChatPanelTestHarness.qml"));
 *   await harness.sendMessage({ type: "user_message", text: "hello" });
 *   expect(await harness.query("messageCount")).toBe(1);
 *   await harness.teardown();
 */
export class QmlTestHarness {
	#process: QmlProcess | null = null;
	#options: QmlTestHarnessOptions;
	#lastObservation: ObservationEntry[] | null = null;

	constructor(options: QmlTestHarnessOptions = {}) {
		this.#options = options;
	}

	#ensureProcess(): void {
		if (!this.#process) throw new Error("QmlTestHarness not set up — call setup() first");
	}

	/** Spawn bridge in stdio+offscreen mode and load the given QML file. */
	async setup(qmlPath: string, props?: Record<string, unknown>): Promise<void> {
		const proc = new QmlProcess({
			env: {
				QT_QPA_PLATFORM: "offscreen",
				...this.#options.env,
			},
		});
		await proc.spawnStdio();
		this.#process = proc;

		proc.send({
			type: "load",
			id: TEST_WINDOW_ID,
			path: qmlPath,
			props: props ?? {},
			title: "Test",
			width: this.#options.width ?? 800,
			height: this.#options.height ?? 600,
		});

		// Wait for ready or error (max 10s)
		const event = await proc.waitFor(
			e => (e.type === "ready" || e.type === "error") && e.id === TEST_WINDOW_ID,
			10_000,
		);
		if (event.type === "error") {
			throw new Error(`QML load failed: ${(event as { type: "error"; id: string; message: string }).message}`);
		}
	}

	/** Send a message to the QML window via bridge.messageReceived. */
	async sendMessage(payload: Record<string, unknown>): Promise<void> {
		this.#ensureProcess();
		this.#process!.send({ type: "message", id: TEST_WINDOW_ID, payload });
	}

	/**
	 * Query QML state via introspection protocol.
	 * Sends {type:'query', query:queryName} to the test harness QML,
	 * then waits for {type:'event', name:'bridge_event', payload:{type:'query_response',...}}.
	 *
	 * The test wrapper QML must handle "query" messages and call bridge.send() with
	 * {type:'query_response', query:queryName, result:...}.
	 */
	async query<T = unknown>(queryName: string): Promise<T> {
		this.#ensureProcess();
		this.#process!.send({ type: "message", id: TEST_WINDOW_ID, payload: { type: "query", query: queryName } });
		const event = await this.#process!.waitFor(
			e =>
				e.type === "event" &&
				e.id === TEST_WINDOW_ID &&
				(e as { type: "event"; payload: Record<string, unknown> }).payload.type === "query_response" &&
				(e as { type: "event"; payload: Record<string, unknown> }).payload.query === queryName,
			5_000,
		);
		return (event as { type: "event"; payload: Record<string, unknown> }).payload.result as T;
	}

	/**
	 * Capture a screenshot of the test window.
	 * Returns the path to the saved PNG file.
	 * If savePath is omitted, a temp file is used.
	 */
	/**
	 * Find elements in the visual tree matching a selector.
	 * Returns all matching items with their requested properties.
	 */
	async findItems(
		selector?: QuerySelector,
		options?: {
			properties?: string[];
			includeGeometry?: boolean;
			maxDepth?: number;
		},
	): Promise<QueryItem[]> {
		this.#ensureProcess();
		this.#process!.send({
			type: "query",
			id: TEST_WINDOW_ID,
			selector: selector ?? {},
			properties: options?.properties ?? [],
			includeGeometry: options?.includeGeometry ?? false,
			maxDepth: options?.maxDepth ?? 20,
		});
		const event = await this.#process!.waitFor(e => e.type === "query_result" && e.id === TEST_WINDOW_ID, 10_000);
		return (event as { type: "query_result"; id: string; items: QueryItem[] }).items;
	}

	/** Find all visible Text elements and return their text content. */
	async findVisibleText(): Promise<string[]> {
		const items = await this.findItems({ type: "QQuickText", visible: true }, { properties: ["text"] });
		return items.map(i => String(i.properties.text ?? "")).filter(t => t.length > 0);
	}

	/**
	 * Assert an element matching the selector exists, is visible, and has positive dimensions.
	 * Throws if not found or dimensions are zero.
	 */
	async assertVisible(selector: QuerySelector): Promise<QueryItem> {
		const items = await this.findItems(selector, { includeGeometry: true });
		if (items.length === 0) {
			throw new Error(`assertVisible: no element found matching ${JSON.stringify(selector)}`);
		}
		const item = items[0];
		if (!item.visible) {
			throw new Error(`assertVisible: element is not visible: ${item.path}`);
		}
		if ((item.geometry?.width ?? 0) <= 0 || (item.geometry?.height ?? 0) <= 0) {
			throw new Error(
				`assertVisible: element has zero dimensions at ${item.path}: ` +
					`${item.geometry?.width}x${item.geometry?.height}`,
			);
		}
		return item;
	}

	/** Assert no element matches the selector. Throws if any match is found. */
	async assertNotFound(selector: QuerySelector): Promise<void> {
		const items = await this.findItems(selector);
		if (items.length > 0) {
			throw new Error(
				`assertNotFound: expected no elements matching ${JSON.stringify(selector)}, found ${items.length}`,
			);
		}
	}

	async click(selector: QuerySelector): Promise<void> {
		this.#ensureProcess();
		this.#process!.send({
			type: "click",
			id: TEST_WINDOW_ID,
			selector: selector ?? {},
		});
		const event = await this.#process!.waitFor(
			e =>
				e.type === "input_result" && e.id === TEST_WINDOW_ID && (e as Record<string, unknown>).command === "click",
			10_000,
		);
		const result = event as { success: boolean; error?: string };
		if (!result.success) throw new Error(`click failed: ${result.error}`);
	}

	async clickAt(x: number, y: number): Promise<void> {
		this.#ensureProcess();
		this.#process!.send({ type: "click", id: TEST_WINDOW_ID, x, y });
		const event = await this.#process!.waitFor(
			e =>
				e.type === "input_result" && e.id === TEST_WINDOW_ID && (e as Record<string, unknown>).command === "click",
			10_000,
		);
		const result = event as { success: boolean; error?: string };
		if (!result.success) throw new Error(`click failed: ${result.error}`);
	}

	async type(text: string, selector?: QuerySelector): Promise<void> {
		if (selector) await this.click(selector);
		this.#ensureProcess();
		this.#process!.send({ type: "type", id: TEST_WINDOW_ID, text });
		const event = await this.#process!.waitFor(
			e => e.type === "input_result" && e.id === TEST_WINDOW_ID && (e as Record<string, unknown>).command === "type",
			10_000,
		);
		const result = event as { success: boolean; error?: string };
		if (!result.success) throw new Error(`type failed: ${result.error}`);
	}

	async press(key: string, modifiers?: string): Promise<void> {
		this.#ensureProcess();
		this.#process!.send({ type: "press", id: TEST_WINDOW_ID, key, modifiers });
		const event = await this.#process!.waitFor(
			e =>
				e.type === "input_result" && e.id === TEST_WINDOW_ID && (e as Record<string, unknown>).command === "press",
			10_000,
		);
		const result = event as { success: boolean; error?: string };
		if (!result.success) throw new Error(`press failed: ${result.error}`);
	}

	async scroll(x: number, y: number, deltaY: number, deltaX?: number): Promise<void> {
		this.#ensureProcess();
		this.#process!.send({ type: "scroll", id: TEST_WINDOW_ID, x, y, deltaY, deltaX });
		const event = await this.#process!.waitFor(
			e =>
				e.type === "input_result" && e.id === TEST_WINDOW_ID && (e as Record<string, unknown>).command === "scroll",
			10_000,
		);
		const result = event as { success: boolean; error?: string };
		if (!result.success) throw new Error(`scroll failed: ${result.error}`);
	}

	async settle(delayMs = 50): Promise<void> {
		// Force a round-trip through the C++ event loop
		await this.evaluate("true");
		if (delayMs > 0) await Bun.sleep(delayMs);
	}

	async observe(): Promise<ObservationEntry[]> {
		const interactiveTypes = ["QQuickMouseArea", "QQuickTextEdit", "QQuickTextInput", "QQuickFlickable"];
		const allItems: ObservationEntry[] = [];
		let nextId = 1;

		for (const typeName of interactiveTypes) {
			const items = await this.findItems(
				{ type: typeName, visible: true },
				{ includeGeometry: true, properties: ["text", "objectName"] },
			);
			for (const item of items) {
				if (!item.geometry || item.geometry.width <= 0 || item.geometry.height <= 0) continue;
				allItems.push({
					id: nextId++,
					className: item.className,
					objectName: item.objectName,
					text: item.properties.text as string | undefined,
					geometry: item.geometry,
					scenePosition: item.scenePosition ?? { x: item.geometry.x, y: item.geometry.y },
					enabled: item.enabled,
					visible: item.visible,
				});
			}
		}

		this.#lastObservation = allItems;
		return allItems;
	}

	async clickId(id: number): Promise<void> {
		if (!this.#lastObservation) throw new Error("Call observe() before clickId()");
		const entry = this.#lastObservation.find(e => e.id === id);
		if (!entry) throw new Error(`No observed element with id ${id}`);
		const x = entry.scenePosition.x + entry.geometry.width / 2;
		const y = entry.scenePosition.y + entry.geometry.height / 2;
		await this.clickAt(x, y);
	}

	/**
	 * Evaluate a JS expression in the QML engine context.
	 * The root QML object is available as `root`.
	 */
	async evaluate<T = unknown>(expression: string): Promise<T> {
		this.#ensureProcess();
		this.#process!.send({ type: "eval", id: TEST_WINDOW_ID, expression });
		const event = await this.#process!.waitFor(e => e.type === "eval_result" && e.id === TEST_WINDOW_ID, 10_000);
		const result = event as { type: "eval_result"; id: string; value: unknown; error: string | null };
		if (result.error !== null) {
			throw new Error(`QML eval error: ${result.error}`);
		}
		return result.value as T;
	}

	async screenshot(savePath?: string): Promise<string> {
		this.#ensureProcess();
		const dest = savePath ?? path.join(os.tmpdir(), `spell-qml-test-${Date.now()}.png`);
		this.#process!.send({ type: "screenshot", id: TEST_WINDOW_ID, path: dest });
		const event = await this.#process!.waitFor(
			e => (e.type === "screenshot" || e.type === "error") && e.id === TEST_WINDOW_ID,
			10_000,
		);
		if (event.type === "error") {
			throw new Error(`Screenshot failed: ${(event as { type: "error"; id: string; message: string }).message}`);
		}
		return (event as { type: "screenshot"; id: string; path: string }).path;
	}

	/**
	 * Reset QML state between tests.
	 * Sends {type:'reset'} and waits for the test harness to confirm.
	 */
	async reset(): Promise<void> {
		this.#ensureProcess();
		this.#process!.send({ type: "message", id: TEST_WINDOW_ID, payload: { type: "reset" } });
		await this.#process!.waitFor(
			e =>
				e.type === "event" &&
				e.id === TEST_WINDOW_ID &&
				(e as { type: "event"; payload: Record<string, unknown> }).payload.type === "reset_done",
			5_000,
		);
	}

	/** Wait for a raw bridge event matching a predicate. Used to capture outgoing _tool invocations. */
	async waitForBridgeEvent(predicate: (event: BridgeEvent) => boolean, timeout = 5_000): Promise<BridgeEvent> {
		this.#ensureProcess();
		return this.#process!.waitFor(predicate, timeout);
	}

	/** Convenience for simulating the _rid response round-trip from armed tools. */
	async simulateToolResponse(rid: string, payload: Record<string, unknown>): Promise<void> {
		await this.sendMessage({ _rid: rid, ...payload });
	}

	/** Kill the bridge process. */
	async teardown(): Promise<void> {
		if (!this.#process) return;
		await this.#process.dispose();
		this.#process = null;
	}
}

export { isBridgeAvailable };
