import { describe, expect, it } from "bun:test";
import { TUI } from "@spell/pi-tui";
import { Loader } from "@spell/pi-tui/components/loader";
import { visibleWidth } from "@spell/pi-tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

describe("Loader component", () => {
	it("clamps rendered lines to terminal width", async () => {
		const term = new VirtualTerminal(1, 4);
		const tui = new TUI(term, { minRenderInterval: 0 });
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["⠸"],
		);
		tui.addChild(loader);

		tui.start();
		await new Promise<void>(r => setImmediate(r));
		await term.flush();

		for (const line of term.getViewport()) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(1);
		}

		loader.stop();
		tui.stop();
	});
});
