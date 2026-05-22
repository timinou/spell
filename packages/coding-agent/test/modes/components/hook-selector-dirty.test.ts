/**
 * Repro for "ask tool arrows don't visually update" — same pattern as BUG-391
 * but for HookSelectorComponent (used by the ask tool via showHookSelector).
 */
import { describe, expect, it } from "bun:test";
import type { DirtyParent } from "@oh-my-pi/pi-tui";
import { HookSelectorComponent } from "../../../src/modes/components/hook-selector";

class DirtyCounter implements DirtyParent {
	count = 0;
	markDirty(): void {
		this.count++;
	}
}

describe("HookSelector arrow keys propagate dirty", () => {
	it("outline mode: arrow down marks parent dirty", () => {
		const sel = new HookSelectorComponent(
			"pick one",
			["a", "b", "c"],
			() => {},
			() => {},
			{ outline: true, maxVisible: 5 },
		);
		const parent = new DirtyCounter();
		sel.setParent(parent);

		parent.count = 0;
		sel.handleInput("\x1b[B"); // down
		sel.handleInput("\x1b[B"); // down
		sel.handleInput("\x1b[A"); // up

		expect(parent.count).toBeGreaterThanOrEqual(3);
	});

	it("non-outline mode: arrow down marks parent dirty", () => {
		const sel = new HookSelectorComponent(
			"pick one",
			["a", "b", "c"],
			() => {},
			() => {},
			{ outline: false, maxVisible: 5 },
		);
		const parent = new DirtyCounter();
		sel.setParent(parent);

		parent.count = 0;
		sel.handleInput("\x1b[B"); // down
		sel.handleInput("\x1b[B"); // down

		expect(parent.count).toBeGreaterThanOrEqual(2);
	});
});
