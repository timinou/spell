import { Box, Spacer, Text } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import type { CustomMessage, IntentionSummaryDetails } from "../../session/messages";

export class IntentionSummaryMessageComponent extends Box {
	#expanded = false;

	constructor(private readonly message: CustomMessage<IntentionSummaryDetails>) {
		super(1, 1, t => theme.bg("customMessageBg", t));
		this.#updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		this.clear();

		const details = this.message.details ?? { did: "", ask: "", trigger: "needs_input" as const };

		let label: string;
		let accent: (text: string) => string;
		if (details.pending) {
			label = "◆ summarizing…";
			accent = (text: string) => theme.fg("planMode", text);
		} else if (details.superseded) {
			label = "◇ past briefing";
			accent = (text: string) => theme.fg("customMessageText", text);
		} else {
			label = "◆ awaiting you";
			accent = (text: string) => theme.fg("planMode", text);
		}

		this.addChild(new Text(accent(label), 0, 0));

		if (details.pending) {
			return;
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("customMessageText", `DID: ${details.did}`), 0, 0));
		if (details.stuck && details.stuck.length > 0) {
			this.addChild(new Text(theme.fg("customMessageText", `STUCK: ${details.stuck}`), 0, 0));
		}
		this.addChild(new Text(theme.fg("customMessageText", `ASK: ${details.ask}`), 0, 0));

		if (this.#expanded && typeof this.message.content === "string" && this.message.content.length > 0) {
			const rendered = [`DID: ${details.did}`];
			if (details.stuck && details.stuck.length > 0) {
				rendered.push(`STUCK: ${details.stuck}`);
			}
			rendered.push(`ASK: ${details.ask}`);
			if (this.message.content !== rendered.join("\n")) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("customMessageText", this.message.content), 0, 0));
			}
		}
	}
}
