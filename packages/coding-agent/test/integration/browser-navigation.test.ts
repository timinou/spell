import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BrowserJourney, isBridgeAvailable } from "../helpers/browser-journey";

const DYNAMIC_HTML = `<!doctype html>
<html>
  <body>
    <article>
      <h1>Navigation Example</h1>
      <p id="intro">Browser navigation test content.</p>
    </article>
    <script>
      setTimeout(() => {
        const button = document.createElement("button");
        button.id = "ready";
        button.textContent = "Loaded";
        button.setAttribute("data-ready", "yes");
        document.body.appendChild(button);
      }, 120);
    </script>
  </body>
</html>`;

describe.skipIf(!isBridgeAvailable())("Browser navigation", () => {
	let browser: BrowserJourney;
	let server: Bun.Server<undefined>;

	beforeAll(async () => {
		server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/dynamic") {
					return new Response(DYNAMIC_HTML, {
						headers: { "content-type": "text/html; charset=utf-8" },
					});
				}
				return new Response("missing", { status: 404 });
			},
		});
		browser = await BrowserJourney.launch();
	});

	afterAll(async () => {
		server.stop(true);
		await browser.teardown();
	});

	it("navigates to an http page and waits for dynamic content", async () => {
		const result = await browser.goto(`http://127.0.0.1:${server.port}/dynamic`);
		expect(result.state).toBe("interactive");
		expect(result.url).toContain("/dynamic");

		await browser.waitForSelector("#ready", 5_000);

		const text = await browser.getText("#ready");
		expect(text.text).toContain("Loaded");

		const attribute = await browser.getAttribute("#ready", "data-ready");
		expect(attribute.value).toBe("yes");

		const html = await browser.getHtml("#ready");
		expect(html.html).toContain("button");

		const readable = await browser.extractReadable("text");
		expect(readable.text).toContain("Navigation Example");
		expect(readable.text).toContain("Browser navigation test content");
	});
});
