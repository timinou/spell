import type { BridgeEvent } from "./protocol";
import { isBridgeAvailable } from "./qml-process";
export interface QuerySelector {
    type?: string;
    objectName?: string;
    visible?: boolean;
    textContains?: string;
}
export interface QueryItem {
    className: string;
    objectName: string;
    geometry?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    scenePosition?: {
        x: number;
        y: number;
    };
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
    geometry: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    scenePosition: {
        x: number;
        y: number;
    };
    enabled: boolean;
    visible: boolean;
}
export interface QmlTestHarnessOptions {
    /** Additional env vars beyond QT_QPA_PLATFORM=offscreen */
    env?: Record<string, string>;
    width?: number;
    height?: number;
}
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
export declare class QmlTestHarness {
    #private;
    constructor(options?: QmlTestHarnessOptions);
    /** Spawn bridge in stdio+offscreen mode and load the given QML file. */
    setup(qmlPath: string, props?: Record<string, unknown>): Promise<void>;
    /** Send a message to the QML window via bridge.messageReceived. */
    sendMessage(payload: Record<string, unknown>): Promise<void>;
    /**
     * Query QML state via introspection protocol.
     * Sends {type:'query', query:queryName} to the test harness QML,
     * then waits for {type:'event', name:'bridge_event', payload:{type:'query_response',...}}.
     *
     * The test wrapper QML must handle "query" messages and call bridge.send() with
     * {type:'query_response', query:queryName, result:...}.
     */
    query<T = unknown>(queryName: string): Promise<T>;
    /**
     * Capture a screenshot of the test window.
     * Returns the path to the saved PNG file.
     * If savePath is omitted, a temp file is used.
     */
    /**
     * Find elements in the visual tree matching a selector.
     * Returns all matching items with their requested properties.
     */
    findItems(selector?: QuerySelector, options?: {
        properties?: string[];
        includeGeometry?: boolean;
        maxDepth?: number;
    }): Promise<QueryItem[]>;
    /** Find all visible Text elements and return their text content. */
    findVisibleText(): Promise<string[]>;
    /**
     * Assert an element matching the selector exists, is visible, and has positive dimensions.
     * Throws if not found or dimensions are zero.
     */
    assertVisible(selector: QuerySelector): Promise<QueryItem>;
    /** Assert no element matches the selector. Throws if any match is found. */
    assertNotFound(selector: QuerySelector): Promise<void>;
    click(selector: QuerySelector): Promise<void>;
    clickAt(x: number, y: number): Promise<void>;
    type(text: string, selector?: QuerySelector): Promise<void>;
    press(key: string, modifiers?: string): Promise<void>;
    scroll(x: number, y: number, deltaY: number, deltaX?: number): Promise<void>;
    settle(delayMs?: number): Promise<void>;
    waitUntil<T>(fn: () => Promise<T | null | false>, timeout?: number): Promise<T>;
    observe(): Promise<ObservationEntry[]>;
    clickId(id: number): Promise<void>;
    /**
     * Evaluate a JS expression in the QML engine context.
     * The root QML object is available as `root`.
     */
    evaluate<T = unknown>(expression: string): Promise<T>;
    screenshot(savePath?: string): Promise<string>;
    /**
     * Reset QML state between tests.
     * Sends {type:'reset'} and waits for the test harness to confirm.
     */
    reset(): Promise<void>;
    /** Wait for a raw bridge event matching a predicate. Used to capture outgoing _tool invocations. */
    waitForBridgeEvent(predicate: (event: BridgeEvent) => boolean, timeout?: number): Promise<BridgeEvent>;
    /** Convenience for simulating the _rid response round-trip from armed tools. */
    simulateToolResponse(rid: string, payload: Record<string, unknown>): Promise<void>;
    /** Kill the bridge process. */
    teardown(): Promise<void>;
}
export { isBridgeAvailable };
//# sourceMappingURL=test-harness.d.ts.map