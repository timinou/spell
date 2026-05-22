/**
 * Regression test for the "exit-on-first-input" bug.
 *
 * Pre-fix chain:
 *   1. BUG-391 added a `try/finally` wrapper to `CustomEditor.handleInput`
 *      that calls `this.markDirty()` in the finally branch.
 *   2. `Editor` (its base class in `@oh-my-pi/pi-tui`) had no public
 *      `markDirty()` method — only the private `this.#parent?.markDirty()`
 *      pattern at internal call sites.
 *   3. Every keystroke therefore threw
 *      `TypeError: this.markDirty is not a function`.
 *   4. The throw fired inside the `process.stdin.on('data', …)` listener
 *      installed by the TUI; Bun converts a synchronous listener throw into
 *      an `'error'` event on the readable stream.
 *   5. BUG-387's pty-loss detector subscribes to `process.stdin` `'error'`
 *      and calls `#onPtyLost('stdin-error')` → `postmortem.quitGracefully`
 *      → exit 0 with no crash report.
 *
 * Net effect: spell exits cleanly the moment the user types anything.
 *
 * This test pins that `CustomEditor.handleInput` is non-throwing for a
 * plain printable keystroke so any future regression of the underlying
 * `markDirty` contract fails here rather than as an opaque clean shutdown.
 */
import { describe, expect, it } from "bun:test";
import type { DirtyParent } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "../../../src/modes/components/custom-editor";

class DirtyCounter implements DirtyParent {
	count = 0;
	markDirty(): void {
		this.count++;
	}
}

describe("CustomEditor exit-on-first-input regression", () => {
	it("does not throw on a plain printable keystroke", () => {
		const editor = new CustomEditor({} as never);
		const parent = new DirtyCounter();
		editor.setParent(parent);

		expect(() => editor.handleInput("x")).not.toThrow();
		// The whole point of BUG-391's finally block is that *some* dirty
		// signal reaches the parent regardless of which branch handled the
		// input; assert that contract still holds.
		expect(parent.count).toBeGreaterThanOrEqual(1);
	});

	it("does not throw on an intercepted control combo (Shift+Tab)", () => {
		const editor = new CustomEditor({} as never);
		const parent = new DirtyCounter();
		editor.setParent(parent);
		// Shift+Tab is one of the early-return branches BUG-391 was filed for.
		editor.onShiftTab = () => {};

		expect(() => editor.handleInput("\x1b[Z")).not.toThrow();
		expect(parent.count).toBeGreaterThanOrEqual(1);
	});
});
