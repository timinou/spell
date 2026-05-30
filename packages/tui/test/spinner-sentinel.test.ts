/**
 * FEAT-776 — Spinner sentinel substitution.
 *
 * Renderers emit SPINNER_MARKER (zero-width APC); TUI substitutes the active
 * glyph at render time so the renderer body never runs per spinner tick.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type Component, type Container, SPINNER_MARKER, spinnerClock, TUI } from "@spell/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class MarkerLeaf implements Component {
	#text: string;
	#parent?: Container;

	constructor(text: string) {
		this.#text = text;
	}

	setParent(p: Container | undefined): void {
		this.#parent = p;
	}

	setText(text: string): void {
		this.#text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.#parent?.markDirty();
	}

	render(_width: number): string[] {
		return [this.#text];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
	await term.flush();
}

describe("FEAT-776 spinner sentinel", () => {
	afterEach(() => {
		spinnerClock.resetForTest();
	});

	it("zero-width APC: SPINNER_MARKER cannot collide with normal text", () => {
		// APC + payload + BEL — terminals ignore unknown APC sequences.
		expect(SPINNER_MARKER.startsWith("\x1b_")).toBe(true);
		expect(SPINNER_MARKER.endsWith("\x07")).toBe(true);
		expect(SPINNER_MARKER.length).toBeGreaterThan(2);
	});

	it("substitutes marker with first frame on initial render", async () => {
		const term = new VirtualTerminal(40, 10);
		const frames = ["A", "B", "C"];
		const tui = new TUI(term, { minRenderInterval: 0, spinnerFrames: frames });
		tui.addChild(new MarkerLeaf(`prefix ${SPINNER_MARKER} suffix`));

		try {
			tui.start();
			await settle(term);
			const viewport = (await term.flushAndGetViewport()).join("\n");
			expect(viewport).toContain("prefix A suffix");
			expect(viewport).not.toContain(SPINNER_MARKER);
		} finally {
			tui.stop();
		}
	});

	it("no spinner subscription without observed marker", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, { minRenderInterval: 0, spinnerFrames: ["A"] });
		tui.addChild(new MarkerLeaf("no spinner here"));

		try {
			tui.start();
			await settle(term);
			// SpinnerClock should have 0 subscribers because no marker emitted.
			expect((spinnerClock as unknown as { tickCount: number }).tickCount).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("setSpinnerFrames updates the active glyph", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term, { minRenderInterval: 0, spinnerFrames: ["X"] });
		const leaf = new MarkerLeaf(SPINNER_MARKER);
		tui.addChild(leaf);

		try {
			tui.start();
			await settle(term);
			let viewport = (await term.flushAndGetViewport()).join("\n");
			expect(viewport).toContain("X");

			tui.setSpinnerFrames(["Y"]);
			leaf.setText(`changed ${SPINNER_MARKER}`);
			tui.requestRender();
			await settle(term);
			viewport = (await term.flushAndGetViewport()).join("\n");
			expect(viewport).toContain("Y");
		} finally {
			tui.stop();
		}
	});
});
