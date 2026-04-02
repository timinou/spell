import * as path from "node:path";
import { QmlTestHarness } from "../../../../packages/qml/src/test-harness.ts";

const qmlPath = "/home/user/code/ora/hotelcomm/ecosystem/agentmaker/.spell/extensions/phoenix-inspector/inspector.qml";
const screenshotPath = path.join(import.meta.dir, "send-to-agent-success.png");
const harness = new QmlTestHarness({ width: 1440, height: 1900 });

try {
	await harness.setup(qmlPath, {
		initialUrl: "http://127.0.0.1:4000/",
		hasExplicitTarget: true,
		tidewaveMcpUrl: "http://localhost:4000/tidewave/mcp",
		taskTierSupported: true,
		quickFixSystemPrompt: "prompt",
		quickFixOutputSchema: { type: "object" },
	});
	await harness.evaluate(`currentUrl = "http://127.0.0.1:4000/"; promptEditor.text = "Tighten spacing"; selectedElement = { tagName: "button", id: "cta", classes: ["btn","primary"], text: "Click me", domPath: "body > button", phxLoc: "lib/app.ex:1", annotations: [], attributes: [], styles: { display: "inline-flex", color: "rgb(255,255,255)" }, rect: { x: 1, y: 2, width: 3, height: 4 } }; sourceLocationText = "lib/app.heex:12"; docsText = "docs"; sourceExcerptText = "excerpt"; sendScreenshot = false;`);
	await harness.settle(200);
	const outboundEventPromise = harness.waitForBridgeEvent(event => event.type === "event", 5_000);
	await harness.evaluate(`sendSelectionToAgent()`);
	const outboundEvent = await outboundEventPromise;
	const rid = String((outboundEvent as { payload: { _rid?: unknown } }).payload._rid || "");
	await harness.simulateToolResponse(rid, {
		action: "agent_handoff_result",
		ok: true,
		status: "submitted",
		message: "Submitted the Phoenix inspector request to the active agent session.",
	});
	await harness.settle(200);
	await harness.screenshot(screenshotPath);
	const statusText = await harness.evaluate<string>(`statusText`);
	const handoffState = await harness.evaluate<string>(`agentHandoffState`);
	const handoffText = await harness.evaluate<string>(`agentHandoffText`);
	const pendingRid = await harness.evaluate<string>(`pendingAgentHandoffRid`);
	console.log(JSON.stringify({
		outbound: (outboundEvent as { payload: Record<string, unknown> }).payload,
		state: { statusText, handoffState, handoffText, pendingRid },
		screenshotPath,
	}, null, 2));
} finally {
	await harness.teardown();
}
