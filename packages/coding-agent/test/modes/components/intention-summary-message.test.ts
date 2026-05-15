import { beforeAll, describe, expect, it } from "bun:test";
import { IntentionSummaryMessageComponent } from "../../../src/modes/components/intention-summary-message";
import { initTheme } from "../../../src/modes/theme/theme";
import {
	type CustomMessage,
	INTENTION_SUMMARY_MESSAGE_TYPE,
	type IntentionSummaryDetails,
} from "../../../src/session/messages";

function msg(details: IntentionSummaryDetails, content = ""): CustomMessage<IntentionSummaryDetails> {
	return {
		role: "custom",
		customType: INTENTION_SUMMARY_MESSAGE_TYPE,
		content,
		display: true,
		details,
		timestamp: 0,
	};
}

function render(component: IntentionSummaryMessageComponent, width = 80): string {
	return component.render(width).join("\n");
}

describe("IntentionSummaryMessageComponent", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders collapsed with did, ask, and no stuck line when stuck is absent", () => {
		const component = new IntentionSummaryMessageComponent(msg({ did: "d", ask: "a", trigger: "needs_input" }));
		const output = render(component);
		expect(output).toContain("◆ awaiting you");
		expect(output).toContain("DID: d");
		expect(output).toContain("ASK: a");
		expect(output).not.toContain("STUCK");
	});

	it("renders stuck line when stuck is provided", () => {
		const component = new IntentionSummaryMessageComponent(
			msg({ did: "d", ask: "a", trigger: "needs_input", stuck: "s" }),
		);
		const output = render(component);
		expect(output).toContain("STUCK: s");
		expect(output).toContain("DID: d");
		expect(output).toContain("ASK: a");
	});

	it("omits stuck line when stuck is empty string", () => {
		const component = new IntentionSummaryMessageComponent(
			msg({ did: "d", ask: "a", trigger: "needs_input", stuck: "" }),
		);
		const output = render(component);
		expect(output).not.toContain("STUCK");
		expect(output).toContain("DID: d");
		expect(output).toContain("ASK: a");
	});

	it("renders summarizing state and no content when pending is true", () => {
		const component = new IntentionSummaryMessageComponent(
			msg({ did: "d", ask: "a", trigger: "needs_input", pending: true }),
		);
		const output = render(component);
		expect(output).toContain("◆ summarizing…");
		expect(output).not.toContain("DID:");
		expect(output).not.toContain("STUCK:");
		expect(output).not.toContain("ASK:");
	});

	it("renders superseded state with dimmed label and content", () => {
		const component = new IntentionSummaryMessageComponent(
			msg({ did: "d", ask: "a", trigger: "needs_input", superseded: true }),
		);
		const output = render(component);
		expect(output).toContain("◇ past briefing");
		expect(output).toContain("DID: d");
		expect(output).toContain("ASK: a");
	});

	it("does not duplicate verbatim content when expanded and content matches rendered lines", () => {
		const component = new IntentionSummaryMessageComponent(
			msg({ did: "d", ask: "a", trigger: "needs_input" }, "DID: d\nASK: a"),
		);
		component.setExpanded(true);
		const output = render(component);
		expect(output).toContain("◆ awaiting you");
		expect(output).toContain("DID: d");
		expect(output).toContain("ASK: a");
		// The verbatim content should NOT appear as a separate block because it matches
		const lines = output.split("\n").filter(line => line.includes("DID: d"));
		expect(lines.length).toBe(1);
	});

	it("renders fallback verbatim content when expanded, content differs, and details are missing", () => {
		const component = new IntentionSummaryMessageComponent({
			role: "custom",
			customType: INTENTION_SUMMARY_MESSAGE_TYPE,
			content: "a totally different string",
			display: true,
			timestamp: 0,
		} as CustomMessage<IntentionSummaryDetails>);
		component.setExpanded(true);
		const output = render(component);
		expect(output).toContain("◆ awaiting you");
		expect(output).toContain("a totally different string");
	});
});
