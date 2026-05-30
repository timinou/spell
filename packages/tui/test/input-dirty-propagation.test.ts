/**
 * BUG-391 — handleInput state mutations must propagate markDirty so the
 * Container dirty-cache (FEAT-762) doesn't serve stale lines.
 *
 * Tests every component whose handleInput has early-return branches that
 * historically skipped markDirty: SelectList, SettingsList, Input, Editor.
 */
import { describe, expect, it } from "bun:test";
import type { DirtyParent } from "@spell/pi-tui";
import { Editor, Input, SelectList, SettingsList } from "@spell/pi-tui";

class DirtyCounter implements DirtyParent {
	count = 0;
	markDirty(): void {
		this.count++;
	}
}

const noopSelectTheme = {
	selectedPrefix: (t: string) => t,
	selectedText: (t: string) => t,
	description: (t: string) => t,
	scrollInfo: (t: string) => t,
	noMatch: (t: string) => t,
	symbols: {
		cursor: ">",
		inputCursor: "|",
		boxRound: { topLeft: "", topRight: "", bottomLeft: "", bottomRight: "", horizontal: "", vertical: "" },
		spinnerFrames: [],
		status: { running: "", pending: "", success: "", error: "", warning: "", aborted: "", info: "" },
	} as any,
};

const noopSettingsTheme = {
	label: (t: string) => t,
	value: (t: string) => t,
	description: (t: string) => t,
	cursor: ">",
	hint: (t: string) => t,
};

describe("BUG-391 dirty propagation", () => {
	describe("SelectList", () => {
		it("up/down/page mutations mark parent dirty", () => {
			const items = [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
			];
			const list = new SelectList(items, 10, noopSelectTheme);
			const parent = new DirtyCounter();
			list.setParent(parent);

			list.handleInput("\x1b[B"); // down
			list.handleInput("\x1b[B"); // down
			list.handleInput("\x1b[A"); // up
			list.handleInput("\x1b[5~"); // page-up (escape sequence)
			list.handleInput("\x1b[6~"); // page-down

			expect(parent.count).toBeGreaterThanOrEqual(5);
		});
	});

	describe("SettingsList", () => {
		it("up/down mutations mark parent dirty", () => {
			const items = [
				{ id: "a", label: "A", currentValue: "1", values: ["1", "2"] },
				{ id: "b", label: "B", currentValue: "x", values: ["x", "y"] },
			];
			const list = new SettingsList(
				items,
				5,
				noopSettingsTheme,
				() => {},
				() => {},
			);
			const parent = new DirtyCounter();
			list.setParent(parent);

			list.handleInput("\x1b[B");
			list.handleInput("\x1b[A");
			list.handleInput(" "); // activate (cycles value)

			expect(parent.count).toBeGreaterThanOrEqual(3);
		});
	});

	describe("Input", () => {
		it("cursor moves mark parent dirty", () => {
			const input = new Input();
			const parent = new DirtyCounter();
			input.setParent(parent);
			input.setValue("hello world");

			parent.count = 0; // reset after setValue
			input.handleInput("\x1b[D"); // left
			input.handleInput("\x1b[C"); // right

			expect(parent.count).toBeGreaterThanOrEqual(2);
		});

		it("paste content marks parent dirty", () => {
			const input = new Input();
			const parent = new DirtyCounter();
			input.setParent(parent);

			// Bracketed paste sequence
			input.handleInput("\x1b[200~pasted content\x1b[201~");

			expect(parent.count).toBeGreaterThanOrEqual(1);
			expect(input.getValue()).toBe("pasted content");
		});
	});

	describe("Editor", () => {
		it("paste content marks parent dirty (would not pre-BUG-391)", () => {
			const editor = new Editor({} as any);
			const parent = new DirtyCounter();
			editor.setParent(parent);

			// Bracketed paste
			editor.handleInput("\x1b[200~hello\x1b[201~");

			expect(parent.count).toBeGreaterThanOrEqual(1);
		});

		it("cursor moves mark parent dirty", () => {
			const editor = new Editor({} as any);
			editor.setText("hello world");
			const parent = new DirtyCounter();
			editor.setParent(parent);

			parent.count = 0;
			editor.handleInput("\x1b[D");
			editor.handleInput("\x1b[C");

			expect(parent.count).toBeGreaterThanOrEqual(2);
		});

		// Regression: BUG-391's CustomEditor.handleInput finally-block calls
		// `this.markDirty()`. Without an `Editor.markDirty()` method, this threw
		// `TypeError: this.markDirty is not a function` on every keystroke. The
		// throw bubbled through `process.stdin.on('data', …)` and was re-emitted
		// as a stdin `'error'` event, which the TUI's pty-loss detector (BUG-387)
		// treated as terminal destruction and quit the session on first input.
		it("exposes a public markDirty() that propagates to parent", () => {
			const editor = new Editor({} as any);
			const parent = new DirtyCounter();
			editor.setParent(parent);

			expect(typeof editor.markDirty).toBe("function");
			editor.markDirty();
			expect(parent.count).toBe(1);
		});
	});
});
