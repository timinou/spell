import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

/**
 * A small floating badge rendered as a TUI overlay when an audit is active.
 * Anchored to the top-left corner (plan-mode overlay occupies top-right).
 *
 * Renders a three-line box:
 *   ╭────────────╮
 *   │ ◈ Audit 1/2 │
 *   ╰────────────╯
 */
export class AuditModeOverlay implements Component {
	#depth: number;
	#maxDepth: number;
	#bg: string | null = null;
	#resetBg: string | null = null;

	constructor(depth: number, maxDepth: number) {
		this.#depth = depth;
		this.#maxDepth = maxDepth;
	}

	update(depth: number, maxDepth: number): void {
		this.#depth = depth;
		this.#maxDepth = maxDepth;
	}

	setBackground(bg: string | null, resetBg: string | null): void {
		this.#bg = bg;
		this.#resetBg = resetBg;
	}

	invalidate(): void {}

	#label(): string {
		// Display as 1-indexed: depth 0 shows "Audit 1/2"
		return `${theme.icon.audit} Audit ${this.#depth + 1}/${this.#maxDepth}`;
	}

	render(_width: number): string[] {
		const colorize = theme.getPlanModeBorderColor();
		const label = this.#label();

		const inner = ` ${label} `;
		const innerWidth = visibleWidth(inner);

		const h = theme.boxSharp.horizontal.repeat(innerWidth);
		let top = colorize(`╭${h}╮`);
		let mid = colorize("│") + theme.fg("accent", inner) + colorize("│");
		let bot = colorize(`╰${h}╯`);

		if (this.#bg && this.#resetBg) {
			top = `${this.#bg}${top}${this.#resetBg}`;
			mid = `${this.#bg}${mid}${this.#resetBg}`;
			bot = `${this.#bg}${bot}${this.#resetBg}`;
		}

		return [top, mid, bot];
	}

	measuredWidth(): number {
		const inner = ` ${this.#label()} `;
		return visibleWidth(inner) + 2;
	}
}
