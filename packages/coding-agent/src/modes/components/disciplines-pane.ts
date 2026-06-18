import { Container, matchesKey, Spacer, Text, truncateToWidth, type Component } from "@spell/pi-tui";
import type { DisciplineRuntimeStat, DisciplineGateOutcome } from "../../config/discipline";
import { theme } from "../../modes/theme/theme";

/**
 * Modal pane displaying discipline runtime stats.
 * Shows per discipline: name, guard, verify checks, armedAt, activationCount, lastFiredAt, lastOutcome, gateBreakdown.
 *
 * Keybindings:
 * - Up/Down: navigate between disciplines
 * - Escape: close pane
 * - Alt+D: toggle open/closed
 */
export class DisciplinesPaneComponent extends Container {
	#stats: DisciplineRuntimeStat[];
	#selectedIndex: number = 0;
	#onClose: () => void;

	constructor(stats: DisciplineRuntimeStat[], onClose: () => void) {
		super();
		this.#stats = stats;
		this.#onClose = onClose;
		this.#render();
	}

	#render(): void {
		this.clear();

		// Header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Discipline Stats"), 1, 0));
		this.addChild(new Spacer(1));

		if (this.#stats.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No discipline stats available."), 0, 0));
			this.addChild(new Text(theme.fg("dim", "  Disciplines are armed and active at runtime."), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc: close  Alt+D: toggle"), 0, 0));
			return;
		}

		// Render stats for each discipline with scroll
		const maxVisible = 15; // max visible lines per discipline
		let renderedCount = 0;

		for (let i = 0; i < this.#stats.length; i++) {
			const stat = this.#stats[i];
			const isSelected = i === this.#selectedIndex;

			// Check if we have room to show this discipline
			if (renderedCount >= maxVisible) {
				const remaining = this.#stats.length - i;
				this.addChild(new Text(theme.fg("muted", `  … +${remaining} more`), 0, 0));
				break;
			}

			// Discipline header (with cursor if selected)
			const cursor = isSelected ? theme.fg("accent", "▶ ") : "  ";
			const header = `${cursor}${theme.bold(stat.name)}`;
			this.addChild(new Text(header, 1, 0));
			renderedCount++;

			// Description if available
			if (stat.description) {
				const descLine = `    ${theme.fg("dim", stat.description)}`;
				this.addChild(new Text(truncateToWidth(descLine, 100), 0, 0));
				renderedCount++;
			}

			// Origin and trigger info
			this.addChild(
				new Text(
					`    Origin: ${theme.fg("muted", stat.origin)} | Trigger: ${theme.fg("muted", stat.on)}`,
					0,
					0,
				),
			);
			renderedCount++;

			// Guard and verify status
			const guardStr = stat.guard ? theme.fg("warning", stat.guard) : theme.fg("muted", "(none)");
			const verifyCmdStr = stat.verifyCmd ? theme.fg("success", "cmd") : theme.fg("dim", "—");
			const verifyReviewStr = stat.verifyReview ? theme.fg("success", "review") : theme.fg("dim", "—");
			this.addChild(
				new Text(`    Guard: ${guardStr} | Verify: ${verifyCmdStr} / ${verifyReviewStr}`, 0, 0),
			);
			renderedCount++;

			// Timing info
			const armedAt = new Date(stat.armedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			const lastFiredStr = stat.lastFiredAt
				? new Date(stat.lastFiredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				: "—";
			this.addChild(
				new Text(`    Armed: ${theme.fg("dim", armedAt)} | Last fired: ${theme.fg("dim", lastFiredStr)}`, 0, 0),
			);
			renderedCount++;

			// Activation count
			this.addChild(new Text(`    Activations: ${theme.fg("accent", String(stat.activationCount))}`, 0, 0));
			renderedCount++;

			// Last outcome if available
			if (stat.lastOutcome) {
				const outcome = stat.lastOutcome;
				const statusStr = outcome.passed ? theme.fg("success", "✓ passed") : theme.fg("error", "✗ failed");
				this.addChild(new Text(`    Last outcome: ${statusStr} (${theme.fg("dim", outcome.gate)})`, 0, 0));
				renderedCount++;

				// Outcome reason if failed
				if (!outcome.passed && outcome.reason) {
					const reasonLine = `      ${theme.fg("error", outcome.reason.slice(0, 80))}`;
					this.addChild(new Text(truncateToWidth(reasonLine, 100), 0, 0));
					renderedCount++;
				}

				// Additional details based on gate type
				if (outcome.gate === "open-work" && outcome.incompleteCount !== undefined) {
					this.addChild(
						new Text(
							`      Incomplete items: ${theme.fg("warning", String(outcome.incompleteCount))}`,
							0,
							0,
						),
					);
					renderedCount++;
				}

				if (outcome.gate === "verify-cmd" && outcome.exitCode !== undefined) {
					const codeStr = outcome.exitCode === 0 ? theme.fg("success", "0") : theme.fg("error", String(outcome.exitCode));
					this.addChild(new Text(`      Exit code: ${codeStr}`, 0, 0));
					renderedCount++;

					if (outcome.stderr) {
						const stderrLine = `      stderr: ${theme.fg("dim", outcome.stderr.slice(0, 60))}…`;
						this.addChild(new Text(truncateToWidth(stderrLine, 100), 0, 0));
						renderedCount++;
					}
				}
			}

			// Gate breakdown
			if (Object.keys(stat.gateBreakdown).length > 0) {
				const breakdownParts: string[] = [];
				for (const [gateKind, count] of Object.entries(stat.gateBreakdown)) {
					if (count > 0) {
						breakdownParts.push(`${gateKind}: ${count}`);
					}
				}
				if (breakdownParts.length > 0) {
					this.addChild(
						new Text(`    Gate stats: ${theme.fg("dim", breakdownParts.join(" | "))}`, 0, 0),
					);
					renderedCount++;
				}
			}

			// Blank line between disciplines
			this.addChild(new Spacer(1));
			renderedCount++;
		}

		// Footer
		this.addChild(new Text(theme.fg("dim", "  Up/Down: navigate  Esc: close  Alt+D: toggle"), 0, 0));
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			if (this.#stats.length === 0) return;
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#stats.length - 1 : this.#selectedIndex - 1;
			this.#render();
			return;
		}

		if (matchesKey(keyData, "down")) {
			if (this.#stats.length === 0) return;
			this.#selectedIndex =
				this.#selectedIndex === this.#stats.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#render();
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "alt+d") || matchesKey(keyData, "ctrl+c")) {
			this.#onClose();
			return;
		}
	}

	invalidate(): void {}
}
