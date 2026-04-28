import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactCreatedEvent } from "../../../src/web/artifacts/types";
import { ArtifactWatcher, filterByExt } from "../../../src/web/artifacts/watcher";

async function waitForEvent(
	predicate: () => ArtifactCreatedEvent | undefined,
	timeoutMs = 1500,
): Promise<ArtifactCreatedEvent> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const event = predicate();
		if (event) return event;
		await Bun.sleep(20);
	}
	throw new Error("watcher did not fire");
}

describe("ArtifactWatcher", () => {
	let root: string;
	let watcher: ArtifactWatcher;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "spell-artifact-watcher-"));
		watcher = new ArtifactWatcher({ debounceMs: 80 });
	});

	afterEach(async () => {
		watcher.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("emits onCreated when a new file lands at <agent>/<tool>/<file>", async () => {
		const events: ArtifactCreatedEvent[] = [];
		watcher.onCreated(e => events.push(e));
		const dir = path.join(root, "main", "bash");
		await fs.mkdir(dir, { recursive: true });
		watcher.watch("sess", root);
		await Bun.sleep(80);
		await Bun.write(path.join(dir, "0.txt"), "hi");

		const ev = await waitForEvent(() => events[0]);
		expect(ev.sessionId).toBe("sess");
		expect(ev.agent).toBe("main");
		expect(ev.tool).toBe("bash");
		expect(ev.filename).toBe("0.txt");
		expect(ev.ext).toBe(".txt");
		expect(ev.mime).toMatch(/text\/plain/);
		expect(ev.uri).toBe("artifact://sess/main/bash/0.txt");
		expect(ev.sizeBytes).toBeGreaterThan(0);
	});

	it("debounces rapid overwrites of the same file", async () => {
		const events: ArtifactCreatedEvent[] = [];
		watcher.onCreated(e => events.push(e));
		const dir = path.join(root, "main", "bash");
		await fs.mkdir(dir, { recursive: true });
		watcher.watch("sess", root);
		await Bun.sleep(80);

		const target = path.join(dir, "burst.txt");
		await Bun.write(target, "v1");
		await Bun.write(target, "v2");
		await Bun.write(target, "v3");
		await Bun.sleep(250);
		expect(events.length).toBeLessThanOrEqual(1);
	});

	it("stop() removes all watchers and stops emissions", async () => {
		const events: ArtifactCreatedEvent[] = [];
		watcher.onCreated(e => events.push(e));
		watcher.watch("sess", root);
		await Bun.sleep(50);
		watcher.stop();

		const dir = path.join(root, "main", "bash");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "x.txt"), "data");
		await Bun.sleep(150);
		expect(events.length).toBe(0);
	});
});

describe("filterByExt", () => {
	const event: ArtifactCreatedEvent = {
		sessionId: "s",
		uri: "artifact://s/a/t/f.pdf",
		agent: "a",
		tool: "t",
		filename: "f.pdf",
		ext: ".pdf",
		mime: "application/pdf",
		sizeBytes: 1,
		ts: 1,
	};

	it("returns true when filter omitted", () => {
		expect(filterByExt(undefined, event)).toBe(true);
		expect(filterByExt([], event)).toBe(true);
	});

	it("matches case-insensitive with or without dot", () => {
		expect(filterByExt(["PDF"], event)).toBe(true);
		expect(filterByExt([".pdf"], event)).toBe(true);
		expect(filterByExt([".png"], event)).toBe(false);
	});

	it("matches when filter contains *", () => {
		expect(filterByExt(["*"], event)).toBe(true);
	});
});
