import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@spell/pi-ai";
import { Container, Image, Markdown, Spacer, Text } from "@spell/pi-tui";
import { _resetSettingsForTest, Settings, settings } from "../../../src/config/settings";
import { AssistantMessageComponent } from "../../../src/modes/components/assistant-message";
import { initTheme } from "../../../src/modes/theme/theme";

function makeMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

function getContentContainer(component: AssistantMessageComponent): Container {
	return (component as any).children[0];
}

describe("AssistantMessageComponent slot reconciliation", () => {
	beforeAll(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	it("reuses single Markdown instance across 1000 text-content updates", () => {
		const component = new AssistantMessageComponent(makeMessage([{ type: "text", text: "a" }]));
		const contentContainer = getContentContainer(component);
		const firstMarkdown = contentContainer.children[1];
		expect(firstMarkdown).toBeInstanceOf(Markdown);

		for (let i = 2; i <= 1000; i++) {
			component.updateContent(makeMessage([{ type: "text", text: "a".repeat(i) }]));
		}

		expect(contentContainer.children[1]).toBe(firstMarkdown);
	});

	it("creates one Markdown per text block; reuses on subsequent updates", () => {
		const component = new AssistantMessageComponent(
			makeMessage([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
				{ type: "text", text: "c" },
			]),
		);
		const contentContainer = getContentContainer(component);
		const markdowns = contentContainer.children.filter(c => c instanceof Markdown);
		expect(markdowns.length).toBe(3);

		for (let i = 0; i < 100; i++) {
			component.updateContent(
				makeMessage([
					{ type: "text", text: `a${i}` },
					{ type: "text", text: `b${i}` },
					{ type: "text", text: `c${i}` },
				]),
			);
		}

		const newMarkdowns = contentContainer.children.filter(c => c instanceof Markdown);
		expect(newMarkdowns.length).toBe(3);
		expect(newMarkdowns[0]).toBe(markdowns[0]);
		expect(newMarkdowns[1]).toBe(markdowns[1]);
		expect(newMarkdowns[2]).toBe(markdowns[2]);
	});

	it("switches slot kind when thinking-block toggles between collapsed/expanded", () => {
		const component = new AssistantMessageComponent(
			makeMessage([{ type: "thinking", thinking: "reasoning..." }]),
			false,
		);
		const contentContainer = getContentContainer(component);
		// Initially expanded: Markdown
		expect(contentContainer.children[1]).toBeInstanceOf(Markdown);

		component.setHideThinkingBlock(true);
		component.updateContent(makeMessage([{ type: "thinking", thinking: "reasoning..." }]));
		// Now collapsed: Text
		expect(contentContainer.children[1]).toBeInstanceOf(Text);
		expect((contentContainer.children[1] as Text).getText()).toContain("Thinking...");
	});

	it("truncates trailing slots when content array shrinks", () => {
		const component = new AssistantMessageComponent(
			makeMessage([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
				{ type: "text", text: "c" },
			]),
		);
		const contentContainer = getContentContainer(component);
		const initialLength = contentContainer.children.length;

		component.updateContent(makeMessage([{ type: "text", text: "a" }]));
		expect(contentContainer.children.length).toBeLessThan(initialLength);
	});

	it("existing visual identity preserved", () => {
		const message = makeMessage([
			{ type: "text", text: "Hello world" },
			{ type: "thinking", thinking: "Hmm..." },
			{ type: "text", text: "Done" },
		]);
		const component = new AssistantMessageComponent(message);
		const output1 = component.render(80).join("\n");

		// Update with same message
		component.updateContent(message);
		const output2 = component.render(80).join("\n");
		expect(output2).toBe(output1);
	});

	it("tool-images mount in dedicated sub-container, don't interleave with text slots", () => {
		const component = new AssistantMessageComponent(makeMessage([{ type: "text", text: "hello" }]));
		component.setToolResultImages("tool-1", [{ type: "image", data: "abc", mimeType: "image/png" }]);
		const contentContainer = getContentContainer(component);
		const children = contentContainer.children;

		expect(children[0]).toBeInstanceOf(Spacer); // leading spacer
		expect(children[1]).toBeInstanceOf(Markdown); // text
		expect(children[2]).toBeInstanceOf(Container); // toolImagesContainer
		// Verify no direct Image in contentContainer
		const directImages = children.filter(c => c instanceof Image);
		expect(directImages.length).toBe(0);
	});

	it("usage info appears as trailing marker only when set", () => {
		settings.set("display.showTokenUsage", true);

		const component1 = new AssistantMessageComponent(makeMessage([{ type: "text", text: "hello" }]));
		const children1 = getContentContainer(component1).children.length;

		const usage: Usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const component2 = new AssistantMessageComponent(makeMessage([{ type: "text", text: "hello" }]));
		component2.setUsageInfo(usage);
		const children2 = getContentContainer(component2).children.length;

		expect(children2).toBeGreaterThan(children1);
	});

	it("calls setText on the stable Markdown for every chunk", () => {
		// Direct evidence for FEAT-763 acceptance: setText fires once per chunk on
		// the reused instance, not a fresh Markdown construction. Guards against a
		// future regression where #updateSlot short-circuits.
		const component = new AssistantMessageComponent(makeMessage([{ type: "text", text: "a" }]));
		const contentContainer = getContentContainer(component);
		const markdown = contentContainer.children[1] as Markdown;
		expect(markdown).toBeInstanceOf(Markdown);

		let setTextCalls = 0;
		const original = markdown.setText.bind(markdown);
		markdown.setText = (text: string) => {
			setTextCalls++;
			original(text);
		};

		const N = 50;
		for (let i = 2; i <= N + 1; i++) {
			component.updateContent(makeMessage([{ type: "text", text: "a".repeat(i) }]));
		}

		expect(setTextCalls).toBe(N);
		expect(contentContainer.children[1]).toBe(markdown); // identity preserved
	});
});
