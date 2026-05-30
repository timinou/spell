import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@spell/pi-coding-agent/session/artifacts";

describe("ArtifactManager", () => {
	let tmpDir: string;
	let sessionId: string;
	let sessionFile: string;
	let rootDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-manager-"));
		sessionId = "14b64b9276f08680"; // pragma: allowlist secret
		sessionFile = path.join(tmpDir, `2026-04-11T09-56-47-707Z_${sessionId}.jsonl`);
		rootDir = sessionFile.slice(0, -6);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("stores main-session artifacts under tool directories with scoped URIs", async () => {
		const manager = new ArtifactManager(sessionFile, sessionId);

		const artifact = await manager.allocatePath("bash");

		expect(artifact.id).toBe("0");
		expect(artifact.uri).toBe(`artifact://${sessionId}/main/bash/0.txt`);
		expect(artifact.path).toBe(path.join(rootDir, "main", "bash", "0.txt"));
		expect(manager.dir).toBe(path.join(rootDir, "main"));
	});

	it("reuses the root session ID for subagent artifacts", async () => {
		const childSessionFile = path.join(rootDir, "0-FindArtifactFiles.jsonl");
		const manager = new ArtifactManager(childSessionFile, "child-session-id");

		const artifact = await manager.allocatePath("screenshot", "png");

		expect(artifact.id).toBe("0");
		expect(artifact.uri).toBe(`artifact://${sessionId}/0-FindArtifactFiles/screenshot/0.png`);
		expect(artifact.path).toBe(path.join(rootDir, "0-FindArtifactFiles", "screenshot", "0.png"));
	});

	it("scans both new-layout and legacy artifacts before allocating the next ID", async () => {
		await Bun.write(path.join(rootDir, "main", "bash", "3.txt"), "main artifact");
		await Bun.write(path.join(rootDir, "5.fetch.log"), "legacy artifact");
		const manager = new ArtifactManager(sessionFile, sessionId);

		const artifact = await manager.allocatePath("fetch");

		expect(artifact.id).toBe("6");
		expect(artifact.uri).toBe(`artifact://${sessionId}/main/fetch/6.txt`);
	});

	it("resolves current-agent artifacts by numeric ID and scoped URI", async () => {
		const manager = new ArtifactManager(sessionFile, sessionId);
		const saved = await manager.save("hello world", "bash");

		expect(await manager.getPath(saved.id)).toBe(saved.path);
		expect(await manager.getPath(saved.uri)).toBe(saved.path);
		expect(await manager.exists(saved.id)).toBe(true);
		expect(await manager.exists(saved.uri)).toBe(true);
	});
});
