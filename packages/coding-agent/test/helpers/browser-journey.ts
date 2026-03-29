import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	BrowserCommandPayload,
	BrowserEventPayload,
	BrowserLifecycleState,
	BrowserObservation,
	BrowserReadableResult,
	BrowserResultEvent,
	BrowserStateEvent,
	BrowserStateSnapshot,
} from "../../src/tools/canvas-browser-protocol";
import { isBridgeAvailable, QmlJourney } from "./qml-journey";

interface BrowserLaunchOptions {
	initialUrl?: string;
	width?: number;
	height?: number;
	settleMs?: number;
	assertTimeout?: number;
	settingsFile?: string;
	storageName?: string;
}

interface BrowserStateResult extends BrowserStateSnapshot {
	lastObservation?: unknown;
}

function randomSuffix(): string {
	return `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
}

function formatBrowserError(event: BrowserResultEvent): string {
	if (!event.error) {
		return `Browser command failed without an error payload: ${event.command}`;
	}
	return `${event.command} failed [${event.error.code}]: ${event.error.message}`;
}

export class BrowserJourney {
	#journey: QmlJourney;
	#settingsFile: string;
	#storageName: string | undefined;
	#ridCounter = 0;

	constructor(journey: QmlJourney, settingsFile: string, storageName?: string) {
		this.#journey = journey;
		this.#settingsFile = settingsFile;
		this.#storageName = storageName;
	}

	static async launch(options?: BrowserLaunchOptions): Promise<BrowserJourney> {
		const settingsFile = options?.settingsFile ?? path.join(os.tmpdir(), `spell-browser-${randomSuffix()}.ini`);
		const storageName = options?.storageName ?? `spell-browser-${randomSuffix()}`;
		const journey = await QmlJourney.launch("canvas/BrowserWindow.qml", {
			props: {
				initialUrl: options?.initialUrl ?? "about:blank",
				settingsFile,
				storageName,
			},
			width: options?.width ?? 1200,
			height: options?.height ?? 800,
			settleMs: options?.settleMs ?? 100,
			assertTimeout: options?.assertTimeout ?? 5000,
		});
		const browser = new BrowserJourney(journey, settingsFile, storageName);
		await browser.waitUntilInteractive();
		return browser;
	}

	async waitUntilInteractive(timeout = 10_000): Promise<void> {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const sync = await this.sync();
			if (sync.state === "interactive") {
				return;
			}
			await Bun.sleep(100);
		}
		throw new Error(`Browser did not reach interactive state within ${timeout}ms`);
	}

	async waitForState(state: BrowserLifecycleState, timeout = 10_000): Promise<BrowserStateEvent> {
		const event = await this.#journey.waitForEvent(raw => {
			if (raw.type !== "event") return false;
			const payload = raw.payload as BrowserEventPayload | undefined;
			return payload?.action === "browser:state" && payload.state === state;
		}, timeout);
		return (event.payload as BrowserStateEvent) ?? (event as unknown as BrowserStateEvent);
	}

	async command(payload: BrowserCommandPayload, timeout = 10_000): Promise<BrowserResultEvent> {
		const rid = payload._rid ?? `browser-${++this.#ridCounter}`;
		const eventPromise = this.#journey.waitForEvent(raw => {
			if (raw.type !== "event") return false;
			const eventPayload = raw.payload as BrowserEventPayload | undefined;
			return eventPayload?.action === "browser:result" && eventPayload._rid === rid;
		}, timeout);
		await this.#journey.agentSends({ ...(payload as unknown as Record<string, unknown>), _rid: rid });
		const event = await eventPromise;
		return event.payload as BrowserResultEvent;
	}

	async commandOk<TResult>(payload: BrowserCommandPayload, timeout = 10_000): Promise<TResult> {
		const result = await this.command(payload, timeout);
		if (!result.ok) {
			throw new Error(formatBrowserError(result));
		}
		return result.result as TResult;
	}

	async sync(timeout = 10_000): Promise<BrowserStateResult> {
		return this.commandOk<BrowserStateResult>({ action: "browser:sync" }, timeout);
	}

	async goto(url: string, timeout = 10_000): Promise<{ url: string; title: string; state: BrowserLifecycleState }> {
		return this.commandOk<{ url: string; title: string; state: BrowserLifecycleState }>(
			{ action: "browser:goto", url },
			timeout,
		);
	}

	async forceReload(timeout = 10_000): Promise<{ url: string; title: string; state: BrowserLifecycleState }> {
		return this.commandOk<{ url: string; title: string; state: BrowserLifecycleState }>(
			{ action: "browser:force_reload" },
			timeout,
		);
	}

	async evaluate<TResult>(script: string, timeout = 10_000): Promise<TResult> {
		return this.commandOk<TResult>({ action: "browser:evaluate", script }, timeout);
	}

	async observe(
		options?: { include_all?: boolean; viewport_only?: boolean; limit?: number },
		timeout = 10_000,
	): Promise<BrowserObservation> {
		return this.commandOk<BrowserObservation>({ action: "browser:observe", ...options }, timeout);
	}

	async clickSelector(selector: string, timeout = 10_000): Promise<unknown> {
		return this.commandOk({ action: "browser:click", selector }, timeout);
	}

	async clickElement(elementId: number, timeout = 10_000): Promise<unknown> {
		return this.commandOk({ action: "browser:click", element_id: elementId }, timeout);
	}

	async fill(selector: string, value: string, timeout = 10_000): Promise<unknown> {
		return this.commandOk({ action: "browser:fill", selector, value }, timeout);
	}

	async typeElement(elementId: number, text: string, timeout = 10_000): Promise<unknown> {
		return this.commandOk({ action: "browser:type", element_id: elementId, text }, timeout);
	}

	async press(key: string, timeout = 10_000): Promise<unknown> {
		return this.commandOk({ action: "browser:press", key }, timeout);
	}

	async scroll(deltaX: number, deltaY: number, timeout = 10_000): Promise<unknown> {
		return this.commandOk({ action: "browser:scroll", delta_x: deltaX, delta_y: deltaY }, timeout);
	}

	async dragBySelector(fromSelector: string, toSelector: string, timeout = 10_000): Promise<unknown> {
		return this.commandOk({ action: "browser:drag", from_selector: fromSelector, to_selector: toSelector }, timeout);
	}

	async waitForSelector(selector: string, timeoutMs = 10_000): Promise<unknown> {
		return this.commandOk(
			{ action: "browser:wait_for_selector", selector, timeout_ms: timeoutMs },
			timeoutMs + 2_000,
		);
	}

	async getText(selector: string, timeout = 10_000): Promise<{ selector: string; text: string }> {
		return this.commandOk<{ selector: string; text: string }>({ action: "browser:get_text", selector }, timeout);
	}

	async getHtml(selector: string, timeout = 10_000): Promise<{ selector: string; html: string }> {
		return this.commandOk<{ selector: string; html: string }>({ action: "browser:get_html", selector }, timeout);
	}

	async getAttribute(
		selector: string,
		attribute: string,
		timeout = 10_000,
	): Promise<{ selector: string; attribute: string; value: string | null }> {
		return this.commandOk<{ selector: string; attribute: string; value: string | null }>(
			{
				action: "browser:get_attribute",
				selector,
				attribute,
			},
			timeout,
		);
	}

	async extractReadable(format: "text" | "markdown" = "markdown", timeout = 10_000): Promise<BrowserReadableResult> {
		return this.commandOk<BrowserReadableResult>({ action: "browser:extract_readable", format }, timeout);
	}

	async emitToolInvocation(payload: Record<string, unknown>, timeout = 5_000): Promise<Record<string, unknown>> {
		const eventPromise = this.#journey.waitForEvent(raw => {
			if (raw.type !== "event") return false;
			const eventPayload = raw.payload as Record<string, unknown> | undefined;
			if (!eventPayload) return false;
			return Object.entries(payload).every(([key, value]) => eventPayload[key] === value);
		}, timeout);
		await this.#journey.evaluate(`bridge.send(${JSON.stringify(payload)})`);
		const event = await eventPromise;
		return event.payload as Record<string, unknown>;
	}

	async settle(delayMs?: number): Promise<void> {
		await this.#journey.settle(delayMs);
	}

	async teardown(options?: { preserveStorage?: boolean }): Promise<void> {
		try {
			await this.#journey.teardown();
		} finally {
			await fs.rm(this.#settingsFile, { force: true });
			if (!options?.preserveStorage && this.#storageName) {
				const storageDir = path.join(
					os.homedir(),
					".local",
					"share",
					"omp-qml-bridge",
					"QtWebEngine",
					this.#storageName,
				);
				await fs.rm(storageDir, { recursive: true, force: true });
			}
		}
	}
}

export { isBridgeAvailable };
