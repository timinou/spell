import { mount } from "svelte";
import Bubble from "../src/components/Bubble.svelte";
import type { ChatBubble } from "../src/lib/reducers";

// Three edit tool_end results the agent could produce, to prove the Bubble
// intent accents (PLAN-338): a multi-file undo, a redo, and a declined undo of
// a committed file (amber safe-stop).
const bubbles: ChatBubble[] = [
	{
		id: "b1",
		kind: "tool_end",
		ts: Date.now() - 4000,
		toolName: "edit",
		text:
			"undo · packages/core/src/registry.ts\n@@ -1 +1 @@\n-export class Registry {\n+export class Store {\n\nundo · packages/core/src/index.ts\n@@ -3 +3 @@\n-import { Registry }\n+import { Store }",
	},
	{
		id: "b2",
		kind: "tool_end",
		ts: Date.now() - 2000,
		toolName: "edit",
		text: "redo · apps/web/src/App.tsx\n@@ -10 +10 @@\n-<Old/>\n+<New/>",
	},
	{
		id: "b3",
		kind: "tool_end",
		ts: Date.now(),
		toolName: "edit",
		text:
			"undo declined: already committed — apps/web/src/App.tsx (f4e5d6c)\n  • re-run with force to revert anyway\n  • or use `git revert`",
	},
];

const target = document.getElementById("harness");
if (target) {
	const heading = document.createElement("h1");
	heading.textContent = "Edit tool results — undo · redo · declined (PLAN-338)";
	target.appendChild(heading);
	for (const bubble of bubbles) {
		const host = document.createElement("div");
		target.appendChild(host);
		mount(Bubble, { target: host, props: { bubble, token: "demo" } });
	}
}
