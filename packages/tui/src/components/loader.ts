import { spinnerClock } from "../spinner-clock";
import type { DirtyParent, TUI } from "../tui";
import { sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";

/**
 * Loader component — spinning animation tied to the shared SpinnerClock.
 *
 * Subscribes only while attached to a parent so detached/queued loaders
 * never drive renders. Visible width matches Text.
 */
export class Loader extends Text {
	#frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	#currentFrame = 0;
	#unsubscribe?: () => void;
	#ui: TUI | null = null;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
		spinnerFrames?: string[],
	) {
		super("", 1, 0);
		this.#ui = ui;
		if (spinnerFrames && spinnerFrames.length > 0) {
			this.#frames = spinnerFrames;
		}
		// Paint the initial frame eagerly so first render shows the spinner.
		this.#updateDisplay();
		// Auto-start: matches legacy behaviour where Loader ticked immediately.
		this.start();
	}

	override setParent(p: DirtyParent | undefined): void {
		super.setParent(p);
		if (p === undefined) {
			// Detached → stop ticking. Re-attach via start() if needed.
			this.#stopTicking();
		}
	}

	render(width: number): string[] {
		const lines = ["", ...super.render(width)];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (visibleWidth(line) > width) {
				lines[i] = sliceByColumn(line, 0, width, true);
			}
		}
		return lines;
	}

	start() {
		if (this.#unsubscribe) return;
		this.#unsubscribe = spinnerClock.subscribe(() => {
			this.#currentFrame = (this.#currentFrame + 1) % this.#frames.length;
			this.#updateDisplay();
			this.#ui?.requestRender();
		});
	}

	stop() {
		this.#stopTicking();
	}

	#stopTicking() {
		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}
	}

	setMessage(message: string) {
		if (this.message === message) return;
		this.message = message;
		this.#updateDisplay();
	}

	#updateDisplay() {
		const frame = this.#frames[this.#currentFrame];
		this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`);
	}
}
