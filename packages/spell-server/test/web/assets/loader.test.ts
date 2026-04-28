import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inferMime, loadWebAssets } from "../../../src/web/assets/loader";

describe("inferMime", () => {
	it("maps common extensions", () => {
		expect(inferMime("index.html")).toMatch(/text\/html/);
		expect(inferMime("app.js")).toMatch(/javascript/);
		expect(inferMime("style.css")).toMatch(/text\/css/);
		expect(inferMime("logo.svg")).toMatch(/svg/);
		expect(inferMime("blob.bin")).toBe("application/octet-stream");
	});
});

describe("loadWebAssets", () => {
	let dist: string;

	beforeEach(async () => {
		dist = await fs.mkdtemp(path.join(os.tmpdir(), "spell-web-loader-"));
		await fs.mkdir(path.join(dist, "assets"), { recursive: true });
		await Bun.write(path.join(dist, "index.html"), "<!doctype html><html><body>spell</body></html>");
		await Bun.write(path.join(dist, "assets", "index-AbC1234567.js"), "console.log('x');");
		await Bun.write(path.join(dist, "assets", "index-AbC1234567.css"), "body { color: #fff; }");
	});

	afterEach(async () => {
		await fs.rm(dist, { recursive: true, force: true });
	});

	it("loads every file under dist", async () => {
		const { assets } = await loadWebAssets(dist);
		expect(assets.size).toBe(3);
		expect(assets.has("/web/index.html")).toBe(true);
		expect(assets.has("/web/assets/index-AbC1234567.js")).toBe(true);
	});

	it("serves /web/ as index.html", async () => {
		const { handle } = await loadWebAssets(dist);
		const response = await handle(new Request("http://localhost/web/"));
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toMatch(/text\/html/);
		expect(await response?.text()).toContain("spell");
	});

	it("flags hashed assets as immutable", async () => {
		const { handle } = await loadWebAssets(dist);
		const response = await handle(new Request("http://localhost/web/assets/index-AbC1234567.js"));
		expect(response?.headers.get("cache-control")).toContain("immutable");
	});

	it("uses no-cache for index.html", async () => {
		const { handle } = await loadWebAssets(dist);
		const response = await handle(new Request("http://localhost/web/index.html"));
		expect(response?.headers.get("cache-control")).toContain("no-cache");
	});

	it("falls back to index.html for unknown SPA routes", async () => {
		const { handle } = await loadWebAssets(dist);
		const response = await handle(new Request("http://localhost/web/sessions/abc123"));
		expect(response?.status).toBe(200);
	});

	it("skips /web/api/ and /web/ws so other handlers run", async () => {
		const { handle } = await loadWebAssets(dist);
		expect(await handle(new Request("http://localhost/web/api/sessions"))).toBeNull();
		expect(await handle(new Request("http://localhost/web/ws"))).toBeNull();
	});

	it("returns 304 on matching If-None-Match", async () => {
		const { assets, handle } = await loadWebAssets(dist);
		const asset = assets.get("/web/index.html");
		expect(asset).toBeDefined();
		const response = await handle(
			new Request("http://localhost/web/index.html", { headers: { "If-None-Match": asset?.etag ?? "" } }),
		);
		expect(response?.status).toBe(304);
	});
});
