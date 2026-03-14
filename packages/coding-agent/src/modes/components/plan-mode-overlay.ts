import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

/**
 * A small floating badge rendered as a TUI overlay when plan mode is active.
 * Anchored to the top-right corner by the caller via showOverlay options.
 *
 * Renders a three-line box:
 *   ╭─────────────╮
 *   │ 🗺 Plotting  │
 *   ╰─────────────╯
 */
export class PlanModeOverlay implements Component {
	#ultraplan: boolean;
	#paused: boolean;

	constructor(ultraplan = false, paused = false) {
		this.#ultraplan = ultraplan;
		this.#paused = paused;
	}

	update(ultraplan: boolean, paused: boolean): void {
		this.#ultraplan = ultraplan;
		this.#paused = paused;
	}

	invalidate(): void {}

	#label(): string {
		if (this.#paused) return `${theme.icon.plan} Paused`;
		if (this.#ultraplan) return `${theme.icon.plan} Grand Scheme`;
		return `${theme.icon.plan} Plotting`;
	}

	render(_width: number): string[] {
		const colorize = theme.getPlanModeBorderColor();
		const label = this.#label();

		// Single space padding on each side of the label
		const inner = ` ${label} `;
		const innerWidth = visibleWidth(inner);

		const h = theme.boxSharp.horizontal.repeat(innerWidth);
		const top = colorize(`╭${h}╮`);
		const mid = colorize("│") + theme.fg("planMode", inner) + colorize("│");
		const bot = colorize(`╰${h}╯`);

		return [top, mid, bot];
	}

	/**
	 * Visible width of this overlay so the caller can pass the correct `width`
	 * to showOverlay — the compositing engine uses this to position the right edge.
	 */
	measuredWidth(): number {
		const inner = ` ${this.#label()} `;
		// ╭ + inner + ╮ → +2 for the box corners
		return visibleWidth(inner) + 2;
	}
}
