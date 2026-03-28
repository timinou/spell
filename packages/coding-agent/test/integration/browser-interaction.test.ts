import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { BrowserObservationEntry } from "../../src/tools/canvas-browser-protocol";
import { BrowserJourney, isBridgeAvailable } from "../helpers/browser-journey";

function dataUrl(html: string): string {
	return `data:text/html,${encodeURIComponent(html)}`;
}

const INTERACTION_HTML = `<!doctype html>
<html>
  <body style="height: 2200px; margin: 0; padding: 24px;">
    <article>
      <h1>Interaction Test</h1>
      <p id="lead">Exercise fill, type, click, press, scroll, and drag.</p>
    </article>
    <input id="field" value="" />
    <button id="submit">Submit</button>
    <div id="drag-source" draggable="true" style="margin-top: 24px;">Drag me</div>
    <div id="drag-target" style="margin-top: 24px; min-height: 40px; border: 1px solid #444;">Drop here</div>
    <script>
      window.__spell = { clicked: 0, value: "", enter: 0, dropped: false, scrollY: 0 };
      const field = document.getElementById("field");
      field.addEventListener("input", event => { window.__spell.value = event.target.value; });
      document.getElementById("submit").addEventListener("click", () => { window.__spell.clicked += 1; });
      document.addEventListener("keydown", event => { if (event.key === "Enter") window.__spell.enter += 1; });
      document.getElementById("drag-target").addEventListener("dragover", event => event.preventDefault());
      document.getElementById("drag-target").addEventListener("drop", event => { event.preventDefault(); window.__spell.dropped = true; });
      window.addEventListener("scroll", () => { window.__spell.scrollY = window.scrollY; });
    </script>
  </body>
</html>`;

describe.skipIf(!isBridgeAvailable())("Browser interaction", () => {
	let browser: BrowserJourney;

	beforeAll(async () => {
		browser = await BrowserJourney.launch();
	});

	afterAll(async () => {
		await browser.teardown();
	});

	it("supports observe-driven interaction commands", async () => {
		await browser.goto(dataUrl(INTERACTION_HTML));
		const observation = await browser.observe({ include_all: true });
		const input = observation.elements.find(entry => entry.tag === "input") as BrowserObservationEntry | undefined;
		const button = observation.elements.find(entry => entry.tag === "button") as BrowserObservationEntry | undefined;

		expect(input).toBeDefined();
		expect(button).toBeDefined();

		await browser.fill("#field", "abc");
		await browser.typeElement(input!.id, "123");
		await browser.clickElement(button!.id);
		await browser.press("Enter");
		await browser.scroll(0, 600);
		await browser.dragBySelector("#drag-source", "#drag-target");

		const state = await browser.evaluate<{
			clicked: number;
			value: string;
			enter: number;
			dropped: boolean;
			scrollY: number;
		}>("window.__spell");
		expect(state.clicked).toBeGreaterThanOrEqual(1);
		expect(state.value).toBe("abc123");
		expect(state.enter).toBeGreaterThanOrEqual(1);
		expect(state.dropped).toBe(true);
		expect(state.scrollY).toBeGreaterThan(0);
	});
});
