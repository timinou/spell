import { Box, Container, Spacer, Text } from "@spell/pi-tui";
import { theme } from "../../modes/theme/theme";

/**
 * Component that renders a yield-gate reminder: the agent tried to stop while a
 * discipline yield-gate was unsatisfied and was re-prompted to continue. Generic
 * over discipline names — the replacement for the old (todo-specific)
 * TodoReminderComponent.
 */
export class YieldReminderComponent extends Container {
	constructor(
		private readonly disciplines: string[],
		private readonly attempt: number,
		private readonly maxAttempts: number,
	) {
		super();

		this.addChild(new Spacer(1));

		const box = new Box(1, 1, t => theme.inverse(theme.fg("warning", t)));
		this.addChild(box);

		const names = disciplines.map(d => theme.bold(d)).join(", ");
		box.addChild(
			new Text(
				`${theme.icon.warning} Yield gate unsatisfied: ${names}  (reminder ${attempt}/${maxAttempts})`,
				0,
				0,
			),
		);
	}
}
