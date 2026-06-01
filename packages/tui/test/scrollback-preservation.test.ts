/**
 * BUG-418 / PLAN-321 — Forced redraws must preserve terminal scrollback.
 *
 * Before the RenderIntent refactor, every forced/width/focus redraw emitted
 * `\x1b[3J` (erase scrollback) + reprinted the whole transcript. On a terminal
 * with scroll-on-output that both snapped the viewport to the bottom AND
 * destroyed the user's history. The fix gates the scrollback wipe behind an
 * explicit `{ clearScrollback: true }` opt-in (used only by /clear); the
 * default forced redraw is now a viewport repaint that keeps history.
 *
 * These tests pin both halves of the contract:
 *   1. requestRender(true)                       -> scrollback preserved, no dup
 *   2. requestRender(true, { clearScrollback })  -> scrollback wiped (session replace)
 */
import { describe, expect, it } from "bun:test";
import { type Component, type Container, TUI } from "@spell/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class MutableLines implements Component {
	#lines: string[];
	#parent?: Container;

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setParent(parent: Container | undefined): void {
		this.#parent = parent;
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
		this.#parent?.markDirty();
	}

	invalidate(): void {
		this.#parent?.markDirty();
	}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
	await term.flush();
}

function rows(count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `MARK-${i}`);
}

function countOccurrences(term: VirtualTerminal, needle: string): number {
	return term.getScrollBuffer().filter(line => line.trim() === needle).length;
}

describe("BUG-418 scrollback preservation", () => {
	it("forced redraw preserves scrollback without duplicating the transcript", async () => {
		// Transcript taller than the viewport so rows spill into scrollback.
		const term = new VirtualTerminal(40, 6);
		const tui = new TUI(term, { minRenderInterval: 0 });
		tui.addChild(new MutableLines(rows(40)));
		try {
			tui.start();
			await settle(term);

			// Baseline: each transcript row appears exactly once in scrollback.
			expect(countOccurrences(term, "MARK-0")).toBe(1);

			// Three forced redraws (resize / focus-change / explicit redraw all
			// route through requestRender(true)).
			for (let i = 0; i < 3; i++) {
				tui.requestRender(true);
				await settle(term);
			}

			// History intact and NOT duplicated — the bug produced N+1 copies.
			expect(countOccurrences(term, "MARK-0")).toBe(1);
			expect(countOccurrences(term, "MARK-20")).toBe(1);
			// Latest content still reachable in history.
			const scrollback = term.getScrollBuffer().map(line => line.trim());
			expect(scrollback).toContain("MARK-39");
		} finally {
			tui.stop();
		}
	});

	it("preexisting shell scrollback survives a forced redraw", async () => {
		// Height 4 with 5 shell lines: shell-0 scrolls into terminal history
		// before the app starts, so it lives in scrollback (not the viewport).
		const term = new VirtualTerminal(40, 4);
		term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
		await term.flush();

		const tui = new TUI(term, { minRenderInterval: 0 });
		tui.addChild(new MutableLines(["ui-0", "ui-1"]));
		try {
			tui.start();
			await settle(term);
			tui.requestRender(true);
			await settle(term);

			// Shell history above the app is preserved (no \x1b[3J wipe).
			expect(term.getScrollBuffer().join("\n").includes("shell-0")).toBeTruthy();
		} finally {
			tui.stop();
		}
	});

	it("clearScrollback opt-in still wipes terminal history (session replace)", async () => {
		const term = new VirtualTerminal(40, 4);
		term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
		await term.flush();

		const tui = new TUI(term, { minRenderInterval: 0 });
		tui.addChild(new MutableLines(["ui-0", "ui-1"]));
		try {
			tui.start();
			await settle(term);

			// /clear semantics: explicit opt-in wipes prior history.
			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			expect(term.getScrollBuffer().join("\n").includes("shell-0")).toBeFalsy();
		} finally {
			tui.stop();
		}
	});
});
