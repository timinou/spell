import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

type TUIOptions = {
	minRenderInterval?: number;
	showHardwareCursor?: boolean;
};

type TUIConstructor = new (terminal: VirtualTerminal, options?: TUIOptions) => TUI;

class StaticComponent implements Component {
	#lines: string[];
	#renderCount = 0;

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	get renderCount(): number {
		return this.#renderCount;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		this.#renderCount += 1;
		return this.#lines;
	}
}

function createTUI(term: VirtualTerminal, options?: TUIOptions): TUI {
	const TUIWithOptions = TUI as unknown as TUIConstructor;
	return new TUIWithOptions(term, options);
}

async function settle(term: VirtualTerminal, delayMs = 20): Promise<void> {
	await Bun.sleep(delayMs);
	await term.flush();
}

async function settleImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function containsLine(term: VirtualTerminal, text: string): boolean {
	return visible(term).some(line => line.includes(text));
}

describe("Render scheduling", () => {
	const activeTuis: TUI[] = [];

	beforeEach(() => {
		activeTuis.length = 0;
	});

	afterEach(() => {
		for (const tui of activeTuis.splice(0)) {
			tui.stop();
		}
	});

	it("render does not fire during process.nextTick phase", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = createTUI(term, { minRenderInterval: 0 });
		activeTuis.push(tui);
		const component = new StaticComponent(["scheduled render"]);
		tui.addChild(component);

		tui.start();
		tui.requestRender();

		const nextTickPhase = Promise.withResolvers<number>();
		process.nextTick(() => nextTickPhase.resolve(component.renderCount));
		expect(await nextTickPhase.promise).toBe(0);

		await settleImmediate();
		await term.flush();
		expect(component.renderCount).toBeGreaterThan(0);
		expect(containsLine(term, "scheduled render")).toBe(true);
	});

	it("rapid requestRender calls within interval produce single render", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = createTUI(term, { minRenderInterval: 50 });
		activeTuis.push(tui);
		const component = new StaticComponent(["first"]);
		tui.addChild(component);

		tui.start();
		await settleImmediate();
		await term.flush();

		const baselineRenderCount = component.renderCount;
		component.setLines(["coalesced"]);
		tui.requestRender();
		await Bun.sleep(10);
		tui.requestRender();

		await settle(term, 60);
		expect(component.renderCount).toBe(baselineRenderCount + 1);
		expect(containsLine(term, "coalesced")).toBe(true);
	});

	it("requestRender after interval fires normally", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = createTUI(term, { minRenderInterval: 50 });
		activeTuis.push(tui);
		const component = new StaticComponent(["initial"]);
		tui.addChild(component);

		tui.start();
		await settleImmediate();
		await term.flush();
		expect(component.renderCount).toBeGreaterThan(0);

		await Bun.sleep(60);
		component.setLines(["after interval"]);
		tui.requestRender();

		await settle(term, 60);
		expect(component.renderCount).toBeGreaterThan(1);
		expect(containsLine(term, "after interval")).toBe(true);
	});

	it("force=true bypasses throttle", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = createTUI(term, { minRenderInterval: 50 });
		activeTuis.push(tui);
		const component = new StaticComponent(["initial"]);
		tui.addChild(component);

		tui.start();
		await settleImmediate();
		await term.flush();

		const baselineRenderCount = component.renderCount;
		component.setLines(["forced"]);
		tui.requestRender(true);

		await settleImmediate();
		await term.flush();
		expect(component.renderCount).toBe(baselineRenderCount + 1);
		expect(containsLine(term, "forced")).toBe(true);
	});

	it("multiple requestRender in same tick produce one render", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = createTUI(term, { minRenderInterval: 0 });
		activeTuis.push(tui);
		const component = new StaticComponent(["before"]);
		tui.addChild(component);

		tui.start();
		await settleImmediate();
		await term.flush();

		const baselineRenderCount = component.renderCount;
		component.setLines(["same tick"]);
		for (let i = 0; i < 5; i += 1) {
			tui.requestRender();
		}

		await settle(term);
		expect(component.renderCount).toBe(baselineRenderCount + 1);
		expect(containsLine(term, "same tick")).toBe(true);
	});

	it("TUI accepts minRenderInterval option", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = createTUI(term, { minRenderInterval: 0 });
		activeTuis.push(tui);
		tui.addChild(new StaticComponent(["option accepted"]));

		expect(() => tui.start()).not.toThrow();
		await settleImmediate();
		await term.flush();
		expect(containsLine(term, "option accepted")).toBe(true);
	});

	it("default minRenderInterval is 16", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		activeTuis.push(tui);
		const component = new StaticComponent(["default interval"]);
		tui.addChild(component);

		tui.start();

		const nextTickPhase = Promise.withResolvers<number>();
		process.nextTick(() => nextTickPhase.resolve(component.renderCount));
		expect(await nextTickPhase.promise).toBe(0);

		await settle(term, 20);
		expect(component.renderCount).toBeGreaterThan(0);
		expect(containsLine(term, "default interval")).toBe(true);
	});

	it("stop clears pending throttle timer", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = createTUI(term, { minRenderInterval: 50 });
		activeTuis.push(tui);
		const component = new StaticComponent(["before stop"]);
		tui.addChild(component);

		tui.start();
		await settleImmediate();
		await term.flush();
		const beforeStop = visible(term);

		component.setLines(["after stop"]);
		tui.requestRender();
		tui.stop();
		activeTuis.pop();

		await settle(term, 100);
		expect(visible(term)).toEqual(beforeStop);
	});
});
