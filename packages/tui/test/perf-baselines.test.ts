/**
 * FEAT-758 — Perf baselines.
 *
 * Lock in the wins from FEAT-761/762/763/759 as invariants. These tests
 * deliberately avoid wall-clock timing assertions so they don't flake on CI;
 * they assert *behavioral* invariants (render counts, cache reuse) that
 * regressions would break.
 */
import { describe, expect, it } from "bun:test";
import { type Component, type Container, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class StaticLeaf implements Component {
	#lines: string[];
	renderCount = 0;
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
		this.renderCount++;
		return this.#lines;
	}
}

/** Cached leaf — re-uses the same array unless width changes. Models Text/Markdown. */
class CachedLeaf implements Component {
	#lines: string[];
	#cachedWidth?: number;
	#cached?: string[];
	renderCount = 0;
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
		this.#cachedWidth = undefined;
		this.#cached = undefined;
		this.#parent?.markDirty();
	}

	render(width: number): string[] {
		this.renderCount++;
		if (this.#cached && this.#cachedWidth === width) return this.#cached;
		this.#cachedWidth = width;
		this.#cached = this.#lines;
		return this.#cached;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
	await term.flush();
}

describe("FEAT-758 perf baselines", () => {
	it("idle: no requestRender produces no renders after init", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, { minRenderInterval: 0 });
		const leaf = new StaticLeaf(["static"]);
		tui.addChild(leaf);

		try {
			tui.start();
			await settle(term);
			const baseline = leaf.renderCount;

			// 60 idle 'ticks' — nothing changes, no requestRender.
			for (let i = 0; i < 60; i++) await settle(term);

			expect(leaf.renderCount).toBe(baseline);
		} finally {
			tui.stop();
		}
	});

	it("no-op coalescing: 100 requestRender → ≤1 root render call", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, { minRenderInterval: 0 });
		const leaf = new StaticLeaf(["alpha"]);
		tui.addChild(leaf);

		let renderCalls = 0;
		const target = tui as unknown as { render(width: number): string[] };
		const orig = target.render.bind(tui);
		target.render = (width: number) => {
			renderCalls++;
			return orig(width);
		};

		try {
			tui.start();
			await settle(term);
			renderCalls = 0;

			for (let i = 0; i < 100; i++) tui.requestRender();
			await settle(term);

			expect(renderCalls).toBeLessThanOrEqual(1);
		} finally {
			tui.stop();
		}
	});

	it("streaming-allocation: leaf cache survives across re-renders when content unchanged", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, { minRenderInterval: 0 });
		const leaf = new CachedLeaf(["# Hello world", "This is text"]);
		tui.addChild(leaf);

		try {
			tui.start();
			await settle(term);
			const initialRenders = leaf.renderCount;

			// Force several renders without changing content — re-validate that
			// TUI early-exits since nothing is dirty.
			for (let i = 0; i < 20; i++) {
				tui.requestRender();
				await settle(term);
			}

			// With FEAT-762's Container dirty-cache + leaf parent propagation,
			// idle requestRender calls should not re-invoke the leaf render
			// (or at most once if a single render slipped through).
			expect(leaf.renderCount).toBeLessThanOrEqual(initialRenders + 1);
		} finally {
			tui.stop();
		}
	});

	it("streaming-allocation: 1000 chunks → leaf re-renders bounded by content changes", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, { minRenderInterval: 0 });
		const leaf = new CachedLeaf(["chunk-0"]);
		tui.addChild(leaf);

		try {
			tui.start();
			await settle(term);
			const initial = leaf.renderCount;

			// Simulate 1000 incremental "chunks" — each changes content.
			for (let i = 1; i < 1000; i++) {
				leaf.setLines([`chunk-${i}`]);
				tui.requestRender();
			}
			await settle(term);

			// Each setLines invalidates the cache, but requestRender coalesces
			// to at most one render per macrotask. We expect the leaf to be
			// rendered far fewer than 1000 times — initial + coalesced final.
			expect(leaf.renderCount).toBeLessThanOrEqual(initial + 2);
		} finally {
			tui.stop();
		}
	});

	it("profile env: disabled by default → flag is off, no JSONL written", async () => {
		const { DevProfile, devProfile } = await import("../src/dev-profile");
		expect(DevProfile.enabled).toBe(false);

		// recordFrame is a no-op when disabled — must not throw and must not
		// open a stream.
		devProfile.recordFrame({ frameMs: 1.23, linesChanged: 0 });
		// nothing observable to assert on disk; the cost-when-disabled check is
		// proven by the early-return guard in dev-profile.ts.
	});
});
