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

	constructor(options: QmlTestHarnessOptions = {}) {
		this.#options = options;
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
		if (!this.#process) throw new Error("QmlTestHarness not set up — call setup() first");
		this.#process.send({ type: "message", id: TEST_WINDOW_ID, payload });
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
		if (!this.#process) throw new Error("QmlTestHarness not set up — call setup() first");
		this.#process.send({ type: "message", id: TEST_WINDOW_ID, payload: { type: "query", query: queryName } });
		const event = await this.#process.waitFor(
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
		if (!this.#process) throw new Error("QmlTestHarness not set up — call setup() first");
		this.#process.send({
			type: "query",
			id: TEST_WINDOW_ID,
			selector: selector ?? {},
			properties: options?.properties ?? [],
			includeGeometry: options?.includeGeometry ?? false,
			maxDepth: options?.maxDepth ?? 20,
		});
		const event = await this.#process.waitFor(e => e.type === "query_result" && e.id === TEST_WINDOW_ID, 10_000);
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

	/**
	 * Evaluate a JS expression in the QML engine context.
	 * The root QML object is available as `root`.
	 */
	async evaluate<T = unknown>(expression: string): Promise<T> {
		if (!this.#process) throw new Error("QmlTestHarness not set up — call setup() first");
		this.#process.send({ type: "eval", id: TEST_WINDOW_ID, expression });
		const event = await this.#process.waitFor(e => e.type === "eval_result" && e.id === TEST_WINDOW_ID, 10_000);
		const result = event as { type: "eval_result"; id: string; value: unknown; error: string | null };
		if (result.error !== null) {
			throw new Error(`QML eval error: ${result.error}`);
		}
		return result.value as T;
	}

	async screenshot(savePath?: string): Promise<string> {
		if (!this.#process) throw new Error("QmlTestHarness not set up — call setup() first");
		const dest = savePath ?? path.join(os.tmpdir(), `spell-qml-test-${Date.now()}.png`);
		this.#process.send({ type: "screenshot", id: TEST_WINDOW_ID, path: dest });
		const event = await this.#process.waitFor(
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
		if (!this.#process) throw new Error("QmlTestHarness not set up — call setup() first");
		this.#process.send({ type: "message", id: TEST_WINDOW_ID, payload: { type: "reset" } });
		await this.#process.waitFor(
			e =>
				e.type === "event" &&
				e.id === TEST_WINDOW_ID &&
				(e as { type: "event"; payload: Record<string, unknown> }).payload.type === "reset_done",
			5_000,
		);
	}

	/** Wait for a raw bridge event matching a predicate. Used to capture outgoing _tool invocations. */
	async waitForBridgeEvent(predicate: (event: BridgeEvent) => boolean, timeout = 5_000): Promise<BridgeEvent> {
		if (!this.#process) throw new Error("QmlTestHarness not set up — call setup() first");
		return this.#process.waitFor(predicate, timeout);
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
