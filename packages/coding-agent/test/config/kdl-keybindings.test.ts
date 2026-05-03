import { describe, expect, it } from "bun:test";
import { parse } from "@bgotink/kdl";

import { parseKeybindingsBlock } from "../../src/config/kdl-keybindings";

describe("parseKeybindingsBlock", () => {
	it("parses canonical keybindings", () => {
		const doc = parse(`
keybindings {
	interrupt "escape"
	clear "ctrl+c"
	exit "ctrl+d"
	cycle-thinking-level "shift+tab"
	cycle-model-forward "ctrl+p"
	cycle-model-backward "shift+ctrl+p"
	toggle-plan-mode "alt+shift+p"
	follow-up "ctrl+enter"
}
`);

		expect(parseKeybindingsBlock(doc)).toEqual({
			interrupt: "escape",
			clear: "ctrl+c",
			exit: "ctrl+d",
			"cycle-thinking-level": "shift+tab",
			"cycle-model-forward": "ctrl+p",
			"cycle-model-backward": "shift+ctrl+p",
			"toggle-plan-mode": "alt+shift+p",
			"follow-up": "ctrl+enter",
		});
	});

	it("normalizes approved legacy aliases", () => {
		const doc = parse(`
keybindings {
	cycle-thinking "shift+tab"
	cycle-model "ctrl+p"
	toggle-plan "alt+shift+p"
}
`);

		expect(parseKeybindingsBlock(doc)).toEqual({
			"cycle-thinking-level": "shift+tab",
			"cycle-model-forward": "ctrl+p",
			"toggle-plan-mode": "alt+shift+p",
		});
	});

	it("returns empty object for empty block", () => {
		const doc = parse("keybindings { }");
		expect(parseKeybindingsBlock(doc)).toEqual({});
	});

	it("returns empty object when block is missing", () => {
		const doc = parse('domain "coding"');
		expect(parseKeybindingsBlock(doc)).toEqual({});
	});
});
