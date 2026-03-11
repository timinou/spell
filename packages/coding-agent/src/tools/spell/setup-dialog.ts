import { Container, getEditorKeybindings, Loader, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import { theme } from "../../modes/theme/theme";

export class SpellSetupDialog extends Container {
	#abortController = new AbortController();
	#contentContainer: Container;
	#loader: Loader | null = null;
	#tui: TUI;

	constructor(tui: TUI) {
		super();
		this.#tui = tui;

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("warning", "Spell Setup"), 1, 0));

		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	/** Replace content with a spinner + message. */
	showPhase(message: string): void {
		this.#loader?.stop();
		this.#loader = null;
		this.#contentContainer.clear();

		this.#contentContainer.addChild(new Spacer(1));

		this.#loader = new Loader(
			this.#tui,
			s => theme.fg("accent", s),
			s => theme.fg("text", s),
			message,
		);
		this.#contentContainer.addChild(this.#loader);
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 1, 0));

		this.#tui.requestRender();
	}

	/** Replace content with a success message (no spinner). */
	showSuccess(message: string): void {
		this.#loader?.stop();
		this.#loader = null;
		this.#contentContainer.clear();

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("success", message), 1, 0));

		this.#tui.requestRender();
	}

	/** Replace content with an error message (no spinner). */
	showError(message: string): void {
		this.#loader?.stop();
		this.#loader = null;
		this.#contentContainer.clear();

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("error", message), 1, 0));

		this.#tui.requestRender();
	}

	/** Handle keyboard input — Escape cancels. */
	handleInput(data: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(data, "selectCancel")) {
			this.#abortController.abort();
		}
	}

	/** Stop spinner timer if active. */
	dispose(): void {
		this.#loader?.stop();
		this.#loader = null;
	}
}
