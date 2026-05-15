import { describe, expect, it } from "bun:test";
import {
	buildIntentionSummaryContent,
	INTENTION_SUMMARY_MESSAGE_TYPE,
	type IntentionSummaryDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";

describe("INTENTION_SUMMARY_MESSAGE_TYPE", () => {
	it("has the expected string value (on-disk stable)", () => {
		expect(INTENTION_SUMMARY_MESSAGE_TYPE).toBe("intentionSummary");
	});
});

describe("buildIntentionSummaryContent", () => {
	it("returns DID and ASK lines when stuck is absent", () => {
		const result = buildIntentionSummaryContent({
			did: "x",
			ask: "y",
			trigger: "needs_input",
		});
		expect(result).toBe("DID: x\nASK: y");
	});

	it("includes STUCK line when stuck is present and non-empty", () => {
		const result = buildIntentionSummaryContent({
			did: "x",
			stuck: "z",
			ask: "y",
			trigger: "needs_input",
		});
		expect(result).toBe("DID: x\nSTUCK: z\nASK: y");
	});

	it("omits STUCK line when stuck is empty string", () => {
		const result = buildIntentionSummaryContent({
			did: "x",
			stuck: "",
			ask: "y",
			trigger: "needs_input",
		});
		expect(result).toBe("DID: x\nASK: y");
	});

	it("locks the IntentionSummaryDetails shape at compile time", () => {
		const d: IntentionSummaryDetails = {
			did: "",
			stuck: "",
			ask: "",
			trigger: "pending_approval",
			eventId: "e",
			pending: true,
			superseded: false,
		};
		// Reference every property so TS errors if the shape drifts.
		expect(d.did).toBe("");
		expect(d.stuck).toBe("");
		expect(d.ask).toBe("");
		expect(d.trigger).toBe("pending_approval");
		expect(d.eventId).toBe("e");
		expect(d.pending).toBe(true);
		expect(d.superseded).toBe(false);
	});
});
