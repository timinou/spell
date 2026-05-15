import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cassetteFetch } from "@oh-my-pi/pi-ai/cassette";

async function tmpDir(): Promise<string> {
	const dir = path.join(import.meta.dir, ".tmp-cassettes", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

async function cleanup(dir: string) {
	await fs.rm(dir, { recursive: true, force: true });
}

describe("cassette", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await tmpDir();
	});

	afterEach(async () => {
		await cleanup(dir);
	});

	it("round-trip buffered", async () => {
		let calls = 0;
		const inner = async () => {
			calls++;
			return new Response("hello", { status: 200 });
		};

		const recordFetch = cassetteFetch(inner as unknown as typeof globalThis.fetch, { dir, mode: "record" });
		const recordResp = await recordFetch("http://example.com");
		expect(await recordResp.text()).toBe("hello");

		// Wait for async persistence
		await new Promise(r => setTimeout(r, 50));
		expect(calls).toBe(1);

		const replayFetch = cassetteFetch(inner as unknown as typeof globalThis.fetch, { dir, mode: "replay" });
		const replayResp = await replayFetch("http://example.com");
		expect(await replayResp.text()).toBe("hello");
		expect(calls).toBe(1); // inner not called again in replay
	});

	it("round-trip SSE", async () => {
		const encoder = new TextEncoder();
		const inner = async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode("data: a\n\n"));
						controller.enqueue(encoder.encode("data: b\n\n"));
						controller.close();
					},
				}),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);

		const recordFetch = cassetteFetch(inner as unknown as typeof globalThis.fetch, { dir, mode: "record" });
		const recordResp = await recordFetch("http://example.com");
		const recordChunks: string[] = [];
		const decoder = new TextDecoder();
		const reader = recordResp.body!.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			recordChunks.push(decoder.decode(value));
		}
		expect(recordChunks).toEqual(["data: a\n\n", "data: b\n\n"]);

		await new Promise(r => setTimeout(r, 50));

		const replayFetch = cassetteFetch(inner as unknown as typeof globalThis.fetch, { dir, mode: "replay" });
		const replayResp = await replayFetch("http://example.com");
		const replayChunks: string[] = [];
		const replayReader = replayResp.body!.getReader();
		while (true) {
			const { done, value } = await replayReader.read();
			if (done) break;
			replayChunks.push(decoder.decode(value));
		}
		expect(replayChunks).toEqual(["data: a\n\n", "data: b\n\n"]);
	});

	it("replay miss", async () => {
		const fetch = cassetteFetch(globalThis.fetch as unknown as typeof globalThis.fetch, { dir, mode: "replay" });
		await expect(fetch("http://example.com")).rejects.toThrow(/fingerprint=/);
		await expect(fetch("http://example.com")).rejects.toThrow(/record first/i);
	});

	it("redaction", async () => {
		const inner = async () => new Response("hello", { status: 200 });
		const recordFetch = cassetteFetch(inner as unknown as typeof globalThis.fetch, { dir, mode: "record" });
		await recordFetch(
			new Request("http://example.com", {
				headers: { authorization: "Bearer secret" },
			}),
		);

		await new Promise(r => setTimeout(r, 50));

		const files = await fs.readdir(dir);
		expect(files.length).toBe(1);

		const cassette = JSON.parse(await Bun.file(path.join(dir, files[0])).text());
		expect(cassette.request.headers.authorization).toBe("<redacted>");
	});

	it("fingerprint stability", async () => {
		const { defaultFingerprint } = await import("@oh-my-pi/pi-ai/cassette/match");

		const req1 = new Request("http://example.com/api", {
			method: "POST",
			body: JSON.stringify({ a: 1, b: 2 }),
			headers: { "content-type": "application/json" },
		});
		const req2 = new Request("http://example.com/api", {
			method: "POST",
			body: JSON.stringify({ b: 2, a: 1 }),
			headers: { "content-type": "application/json" },
		});
		const req3 = new Request("http://example.com/api", {
			method: "POST",
			body: JSON.stringify({ a: 1, b: 3 }),
			headers: { "content-type": "application/json" },
		});

		const fp1 = await defaultFingerprint(req1);
		const fp2 = await defaultFingerprint(req2);
		const fp3 = await defaultFingerprint(req3);

		expect(fp1).toBe(fp2);
		expect(fp1).not.toBe(fp3);
		expect(fp2).not.toBe(fp3);
	});
});
