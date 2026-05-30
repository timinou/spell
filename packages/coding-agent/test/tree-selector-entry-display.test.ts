/**
 * Tests that every SessionEntry type in tree-selector.ts has:
 * 1. A display text handler (#getEntryDisplayText) — no [undefined] output
 * 2. A search text handler (#getSearchableText) — searchable by relevant terms
 * 3. Correct filter classification — bookkeeping entries hidden in default mode
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { TreeSelectorComponent } from "@spell/pi-coding-agent/modes/components/tree-selector";
import { getThemeByName, setThemeInstance } from "@spell/pi-coding-agent/modes/theme/theme";
import { SessionManager } from "@spell/pi-coding-agent/session/session-manager";
import { assistantMsg, userMsg } from "./utilities";

beforeAll(async () => {
	const t = await getThemeByName("dark");
	setThemeInstance(t!);
});

// Strip ANSI escape sequences for assertion on rendered lines
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\]\d+;[^\x07]*\x07/g;
function strip(s: string): string {
	return s.replace(ANSI_RE, "").trim();
}
/**
 * Helper: render the tree and return printable text for each visible line.
 * Excludes the status line (last line showing "(N/M) [filter]").
 */
function renderTreeText(session: SessionManager, filterMode: "default" | "all" = "default"): string[] {
	const tree = session.getTree();
	let _selectCalled = false;
	const component = new TreeSelectorComponent(
		tree,
		null,
		40, // terminalHeight
		_id => {
			_selectCalled = true;
		},
		() => {},
		undefined,
		filterMode,
	);
	const treeList = component.getTreeList();
	const lines = treeList.render(200);
	// Last line is the status "(N/M) [filter]", skip it
	return lines.slice(0, -1).map(line => strip(line));
}

describe("tree-selector entry display", () => {
	describe("previously-unhandled entry types render meaningful text", () => {
		it("mode_change renders [mode: <name>]", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.appendModeChange("plan", { file: "plan.org" });

			const lines = renderTreeText(session, "all");
			const modeLine = lines.find(l => l.includes("[mode:"));
			expect(modeLine).toBeDefined();
			expect(modeLine).toContain("[mode: plan]");
		});

		it("service_tier_change renders [tier: <value>]", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.appendServiceTierChange("flex");

			const lines = renderTreeText(session, "all");
			const tierLine = lines.find(l => l.includes("[tier:"));
			expect(tierLine).toBeDefined();
			expect(tierLine).toContain("[tier: flex]");
		});

		it("service_tier_change with null renders [tier: (none)]", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.appendServiceTierChange(null);

			const lines = renderTreeText(session, "all");
			const tierLine = lines.find(l => l.includes("[tier:"));
			expect(tierLine).toBeDefined();
			expect(tierLine).toContain("[tier: (none)]");
		});

		it("session_init renders [session init]", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.appendSessionInit({
				systemPrompt: "You are a test agent",
				task: "Do things",
				tools: ["read", "write"],
			});

			const lines = renderTreeText(session, "all");
			const initLine = lines.find(l => l.includes("[session init]"));
			expect(initLine).toBeDefined();
		});

		it("ttsr_injection renders [ttsr: rule1, rule2]", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.appendTtsrInjection(["canvas-activation", "code-quality"]);

			const lines = renderTreeText(session, "all");
			const ttsrLine = lines.find(l => l.includes("[ttsr:"));
			expect(ttsrLine).toBeDefined();
			expect(ttsrLine).toContain("[ttsr: canvas-activation, code-quality]");
		});
	});

	describe("no entry type produces [undefined] or empty text", () => {
		it("all entry types produce non-empty, non-undefined display text", () => {
			const session = SessionManager.inMemory();

			// Add one of every entry type
			session.appendMessage(userMsg("hello user"));
			session.appendMessage(assistantMsg("hello assistant"));
			session.appendModelChange("anthropic/claude-4");
			session.appendThinkingLevelChange("high");
			session.appendServiceTierChange("flex");
			session.appendModeChange("plan");
			session.appendSessionInit({
				systemPrompt: "sys",
				task: "task",
				tools: ["bash"],
			});
			session.appendTtsrInjection(["rule-a"]);

			const lines = renderTreeText(session, "all");

			// Every rendered line must have non-empty, non-undefined content
			for (const line of lines) {
				expect(line.length).toBeGreaterThan(0);
				expect(line).not.toContain("[undefined]");
				expect(line).not.toContain("undefined undefined");
			}
		});
	});

	describe("filter classification", () => {
		it("bookkeeping entries are hidden in default filter mode", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("visible user msg"));
			session.appendModeChange("plan");
			session.appendServiceTierChange("flex");
			session.appendSessionInit({
				systemPrompt: "sys",
				task: "task",
				tools: [],
			});
			session.appendTtsrInjection(["rule-x"]);
			session.appendMessage(assistantMsg("visible assistant msg"));

			const defaultLines = renderTreeText(session, "default");
			const allLines = renderTreeText(session, "all");

			// Default view should not show mode_change, service_tier_change, session_init, ttsr_injection
			expect(defaultLines.some(l => l.includes("[mode:"))).toBe(false);
			expect(defaultLines.some(l => l.includes("[tier:"))).toBe(false);
			expect(defaultLines.some(l => l.includes("[session init]"))).toBe(false);
			expect(defaultLines.some(l => l.includes("[ttsr:"))).toBe(false);

			// But user/assistant messages are visible
			expect(defaultLines.some(l => l.includes("visible user msg"))).toBe(true);
			expect(defaultLines.some(l => l.includes("visible assistant msg"))).toBe(true);

			// All view shows everything
			expect(allLines.some(l => l.includes("[mode:"))).toBe(true);
			expect(allLines.some(l => l.includes("[tier:"))).toBe(true);
			expect(allLines.some(l => l.includes("[session init]"))).toBe(true);
			expect(allLines.some(l => l.includes("[ttsr:"))).toBe(true);
		});
	});

	describe("search indexing", () => {
		it("mode_change is searchable by mode name", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("unrelated"));
			session.appendModeChange("plan");

			// Render in "all" mode — search filters within visible entries
			const tree = session.getTree();
			const component = new TreeSelectorComponent(
				tree,
				null,
				40,
				() => {},
				() => {},
				undefined,
				"all",
			);
			const treeList = component.getTreeList();

			// Type search query "plan" — this triggers the search filter
			// The handleInput method processes printable characters as search
			for (const ch of "plan") {
				treeList.handleInput(ch);
			}
			const lines = treeList.render(200).slice(0, -1);
			const printable = lines.map(l => strip(l));

			// The mode_change entry should survive the search filter
			expect(printable.some(l => l.includes("[mode: plan]"))).toBe(true);
		});

		it("ttsr_injection is searchable by rule name", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("unrelated"));
			session.appendTtsrInjection(["canvas-activation"]);

			const tree = session.getTree();
			const component = new TreeSelectorComponent(
				tree,
				null,
				40,
				() => {},
				() => {},
				undefined,
				"all",
			);
			const treeList = component.getTreeList();

			for (const ch of "canvas") {
				treeList.handleInput(ch);
			}
			const lines = treeList.render(200).slice(0, -1);
			const printable = lines.map(l => strip(l));

			expect(printable.some(l => l.includes("[ttsr:"))).toBe(true);
		});
	});

	describe("defensive rendering", () => {
		it("toolResult with missing toolCallId renders [tool] not [undefined]", () => {
			const session = SessionManager.inMemory();
			// Construct a toolResult message with no toolCallId/toolName
			session.appendMessage({
				role: "toolResult" as const,
				content: [{ type: "text" as const, text: "some result" }],
				timestamp: Date.now(),
			} as never);

			const lines = renderTreeText(session, "all");
			for (const line of lines) {
				expect(line).not.toContain("[undefined]");
				expect(line).not.toContain("undefined");
			}
		});
	});
});
