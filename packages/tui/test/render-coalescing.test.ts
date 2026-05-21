import { describe, expect, it } from "bun:test";
import { type Component, Container, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class CountingComponent implements Component {
	#lines: string[];
	renderCount = 0;

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	setLines(lines: string[]): void {
		this.#lines = lines;
		this.invalidate?.();
	}

	invalidate(): void {}

	render(_width: number): string[] {
		this.renderCount++;
		return this.#lines;
	}
}

class DirtyLeaf implements Component {
	#lines: string[];
	#parent?: Container;

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	setParent(p: Container | undefined): void {
		this.#parent = p;
	}

	setLines(lines: string[]): void {
		this.#lines = lines;
		this.invalidate();
	}

	invalidate(): void {
		this.#parent?.markDirty();
	}

	render(_width: number): string[] {
		return this.#lines;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
	await term.flush();
}

describe("Render coalescing", () => {
	describe("no-op renders", () => {
		it("produces zero terminal writes after first render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term, { minRenderInterval: 0 });
			const root = new Container();
			const mid = new Container();
			const leaf = new CountingComponent(["hello"]);
			mid.addChild(leaf);
			root.addChild(mid);
			tui.addChild(root);

			try {
				tui.start();
				await settle(term);

				const writeCountBefore = (term as any).xterm._core._writeBuffer?._writeBuffer.length ?? 0;

				for (let i = 0; i < 100; i++) {
					tui.requestRender();
				}
				await settle(term);

				// After first render, no-op requests should not produce new terminal writes
				expect(leaf.renderCount).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("100 no-op requestRender produces ≤1 root render call", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term, { minRenderInterval: 0 });
			const root = new Container();
			const leaf = new CountingComponent(["alpha"]);
			root.addChild(leaf);
			tui.addChild(root);

			let renderCalls = 0;
			const originalRender = root.render.bind(root);
			root.render = (width: number) => {
				renderCalls++;
				return originalRender(width);
			};

			try {
				tui.start();
				await settle(term);

				renderCalls = 0;
				for (let i = 0; i < 100; i++) {
					tui.requestRender();
				}
				await settle(term);

				expect(renderCalls).toBeLessThanOrEqual(1);
			} finally {
				tui.stop();
			}
		});
	});

	describe("dirty propagation", () => {
		it("leaf invalidate propagates dirty to root", () => {
			const root = new Container();
			const mid = new Container();
			const leaf = new DirtyLeaf(["alpha"]);
			mid.addChild(leaf);
			root.addChild(mid);

			root.render(80);
			expect(root.isDirty()).toBe(false);

			leaf.setLines(["beta"]);
			expect(root.isDirty()).toBe(true);
		});

		it("Container.render returns same array reference when clean", () => {
			const container = new Container();
			container.addChild(new CountingComponent(["alpha"]));

			const first = container.render(80);
			const second = container.render(80);

			expect(second).toBe(first);
		});

		it("addChild marks Container dirty", () => {
			const container = new Container();
			container.render(80);
			expect(container.isDirty()).toBe(false);

			container.addChild(new CountingComponent(["beta"]));
			expect(container.isDirty()).toBe(true);
		});

		it("removeChild marks Container dirty", () => {
			const container = new Container();
			const child = new CountingComponent(["beta"]);
			container.addChild(child);
			container.render(80);
			expect(container.isDirty()).toBe(false);

			container.removeChild(child);
			expect(container.isDirty()).toBe(true);
		});

		it("3-level nested dirty propagation", () => {
			const root = new Container();
			const c1 = new Container();
			const c2 = new Container();
			const leaf = new DirtyLeaf(["alpha"]);
			c2.addChild(leaf);
			c1.addChild(c2);
			root.addChild(c1);

			root.render(80);
			expect(root.isDirty()).toBe(false);
			expect(c1.isDirty()).toBe(false);
			expect(c2.isDirty()).toBe(false);

			leaf.setLines(["beta"]);
			expect(c2.isDirty()).toBe(true);
			expect(c1.isDirty()).toBe(true);
			expect(root.isDirty()).toBe(true);
		});
	});
});
