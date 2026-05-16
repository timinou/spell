import { describe, expect, it } from "bun:test";
import { DEFAULT_APP_KEYBINDINGS, KeybindingsManager } from "../src/config/keybindings";

describe("KeybindingsManager.getDisplayString", () => {
	it("formats a single binding as a human-readable key hint", () => {
		const keybindings = KeybindingsManager.inMemory({
			dequeue: "alt+up",
		});

		expect(keybindings.getDisplayString("dequeue")).toBe("Alt+Up");
	});

	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			copyPrompt: ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("copyPrompt")).toBe("Alt+Shift+C/Ctrl+Shift+C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			copyPrompt: [],
		});

		expect(keybindings.getDisplayString("copyPrompt")).toBe("");
	});
});

describe("subagentViewer default keybinding", () => {
	// Ghostty (and several other terminals) consume ctrl+tab for their own
	// tab-cycling, swallowing the kitty CSI-u sequence before it reaches
	// Spell. Default to alt+j which is unclaimed by mainstream terminals.
	it("defaults to alt+j to avoid Ghostty ctrl+tab conflict", () => {
		expect(DEFAULT_APP_KEYBINDINGS.subagentViewer).toBe("alt+j");
	});

	it("renders the alt+j default in display string form", () => {
		const keybindings = KeybindingsManager.inMemory({});
		expect(keybindings.getDisplayString("subagentViewer")).toBe("Alt+J");
	});
});
