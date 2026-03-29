import { describe, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const HARNESS_QML = "panels/BrowseChatPanelTestHarness.qml";
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WmP4xQAAAAASUVORK5CYII=";

async function launchHarness(): Promise<QmlJourney> {
	return QmlJourney.launch(HARNESS_QML, {
		width: 900,
		height: 700,
		settleMs: 100,
		assertTimeout: 5_000,
	});
}

describe.skipIf(!isBridgeAvailable())("Browse chat delegates", () => {
	it("renders assistant flow text and collapsible thinking", async () => {
		const journey = await launchHarness();
		try {
			await journey.agentSends({ type: "message_start", id: "assistant-1", role: "assistant" });
			await journey.agentSends({
				type: "message_update",
				id: "assistant-1",
				text: "Research summary",
				thinking: "Trace sources before summarizing",
			});
			await journey.agentSends({ type: "message_end", id: "assistant-1" });

			await journey.expectVisible({ objectName: "flowAssistant", visible: true });
			await journey.expectVisible({ objectName: "thinkingBlock", visible: true });
			await journey.expectText("Research summary");
			await journey.expectNotFound({ objectName: "thinkingBody", visible: true });
			await journey.click({ objectName: "thinkingHeader", visible: true });
			await journey.expectVisible({ objectName: "thinkingBody", visible: true });
			await journey.expectText("Trace sources before summarizing");
		} finally {
			await journey.teardown();
		}
	}, 10_000);

	it("renders user messages with the flow user delegate", async () => {
		const journey = await launchHarness();
		try {
			await journey.agentSends({ type: "user_message", text: "Investigate browser tabs" });
			await journey.expectVisible({ objectName: "flowUser", visible: true });
			await journey.expectText("Investigate browser tabs");
		} finally {
			await journey.teardown();
		}
	}, 10_000);

	it("renders tool executions with expandable details", async () => {
		const journey = await launchHarness();
		try {
			await journey.agentSends({ type: "tool_start", id: "tool-1", name: "fetch", details: "Fetching sources" });
			await journey.agentSends({ type: "tool_end", id: "tool-1", name: "fetch", details: "Loaded 3 sources" });
			await journey.expectVisible({ objectName: "flowTool", visible: true });
			await journey.expectText("fetch");
			await journey.expectText("done");
			await journey.click({ objectName: "toolHeader", visible: true });
			await journey.expectVisible({ objectName: "toolDetails", visible: true });
			await journey.expectText("Loaded 3 sources");
		} finally {
			await journey.teardown();
		}
	}, 10_000);

	it("renders inline image previews", async () => {
		const journey = await launchHarness();
		try {
			await journey.agentSends({
				type: "image_result",
				id: "img-1",
				data: TINY_PNG_BASE64,
				mimeType: "image/png",
			});
			await journey.settle(250);
			await journey.expectVisible({ objectName: "flowImage", visible: true });
		} finally {
			await journey.teardown();
		}
	}, 10_000);
});
