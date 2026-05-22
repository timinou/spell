/**
 * Microbenchmarks for TUI render hot paths. Not asserting wall-clock
 * thresholds (would flake on CI); we print metrics for human inspection
 * when run with PI_BENCH=1, and assert structural invariants otherwise.
 */
import { describe, expect, it } from "bun:test";
import { Container, Editor, Markdown, TUI } from "@oh-my-pi/pi-tui";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

const BENCH = process.env.PI_BENCH === "1";

function buildChatContainer(messageCount: number): Container {
	const root = new Container();
	for (let i = 0; i < messageCount; i++) {
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		md.setText(
			`# Message ${i}\n\nHello world, this is message **${i}** with some _formatting_.\n\n- bullet a\n- bullet b\n- bullet c\n\n\`\`\`ts\nconst x = ${i};\n\`\`\``,
		);
		root.addChild(md);
	}
	return root;
}

function bench(label: string, iter: number, fn: () => void): number {
	// Warmup
	for (let i = 0; i < Math.min(5, iter); i++) fn();
	const start = performance.now();
	for (let i = 0; i < iter; i++) fn();
	const elapsed = performance.now() - start;
	const perIter = elapsed / iter;
	if (BENCH) {
		// eslint-disable-next-line no-console
		console.log(`  ${label}: ${perIter.toFixed(3)}ms/iter (${iter} iters, ${elapsed.toFixed(0)}ms total)`);
	}
	return perIter;
}

describe("render microbench", () => {
	it("chat scroll: 200 cached Markdowns + 1 changed", () => {
		const term = new VirtualTerminal(120, 40);
		const tui = new TUI(term, { minRenderInterval: 0 });

		const chat = buildChatContainer(200);
		tui.addChild(chat);

		const lastMessage = chat.children[chat.children.length - 1] as Markdown;

		tui.start();
		// Initial render to populate caches
		tui.render(120);

		const perIter = bench("steady-state render (200 cached)", 50, () => {
			tui.render(120);
		});

		const perDirty = bench("one dirty leaf (text grows)", 50, () => {
			lastMessage.setText(`# Updated ${Math.random()}`);
			tui.render(120);
		});

		tui.stop();

		// Structural: cached render should be < 1ms; dirty render < 10ms
		// (loose bounds; assertions only fail if catastrophic regression)
		expect(perIter).toBeLessThan(10);
		expect(perDirty).toBeLessThan(50);
	});

	it("streaming: token-by-token Markdown.setText (worst case)", () => {
		const term = new VirtualTerminal(120, 40);
		const tui = new TUI(term, { minRenderInterval: 0 });
		const chat = new Container();
		for (let i = 0; i < 50; i++) {
			const md = new Markdown("", 0, 0, defaultMarkdownTheme);
			md.setText(`Message ${i}: lorem ipsum dolor sit amet, **consectetur** adipiscing elit.`);
			chat.addChild(md);
		}
		const streaming = new Markdown("", 0, 0, defaultMarkdownTheme);
		chat.addChild(streaming);
		tui.addChild(chat);
		tui.start();
		tui.render(120);

		const chunks = Array.from({ length: 200 }, (_, i) =>
			`This is streamed token #${i} with some **formatting** and \`code\` snippets.\n`.repeat(Math.min(i + 1, 20)),
		);

		let idx = 0;
		const perIter = bench("streaming token (50 cached + 1 grows)", chunks.length, () => {
			streaming.setText(chunks[idx++ % chunks.length]);
			tui.render(120);
		});

		tui.stop();
		expect(perIter).toBeLessThan(50);
	});

	it("editor: render with growing input", () => {
		const term = new VirtualTerminal(120, 40);
		const tui = new TUI(term, { minRenderInterval: 0 });
		const editor = new Editor(defaultEditorTheme);
		tui.addChild(editor);
		tui.start();

		editor.setText("Line 1\n".repeat(10));
		tui.render(120);

		const perIter = bench("editor render (small)", 100, () => {
			editor.handleInput("a");
			tui.render(120);
		});

		editor.setText("x".repeat(2000));
		tui.render(120);

		const perIterBig = bench("editor render (2000 chars)", 100, () => {
			editor.handleInput("a");
			tui.render(120);
		});

		tui.stop();
		expect(perIter).toBeLessThan(20);
		expect(perIterBig).toBeLessThan(50);
	});

	it("string diff cost: previousLines vs newLines comparison", () => {
		const oldLines: string[] = [];
		const newLines: string[] = [];
		for (let i = 0; i < 200; i++) {
			oldLines.push(`line ${i} content with some text padding`);
			newLines.push(`line ${i} content with some text padding`);
		}
		// Change just one line in the middle
		newLines[100] = "different line content here";

		const perIter = bench("diff loop (200 lines, 1 differ)", 1000, () => {
			let firstChanged = -1;
			let lastChanged = -1;
			const maxLines = Math.max(newLines.length, oldLines.length);
			for (let i = 0; i < maxLines; i++) {
				if (oldLines[i] !== newLines[i]) {
					if (firstChanged === -1) firstChanged = i;
					lastChanged = i;
				}
			}
			expect(firstChanged).toBe(100);
			expect(lastChanged).toBe(100);
		});
		expect(perIter).toBeLessThan(2);
	});
});
