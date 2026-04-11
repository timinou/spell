import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ArtifactProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

describe("ArtifactProtocolHandler", () => {
	let projectDir: string;
	let currentSessionId: string;
	let currentRoot: string;
	let router: InternalUrlRouter;

	beforeEach(async () => {
		projectDir = path.join(
			getSessionsDir(),
			`artifact-protocol-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		currentSessionId = "14b64b9276f08680"; // pragma: allowlist secret
		currentRoot = path.join(projectDir, `2026-04-11T09-56-47-707Z_${currentSessionId}`);
		await fs.mkdir(currentRoot, { recursive: true });
		router = new InternalUrlRouter();
		router.register(
			new ArtifactProtocolHandler({
				getArtifactsDir: () => currentRoot,
			}),
		);
	});

	afterEach(async () => {
		await fs.rm(projectDir, { recursive: true, force: true });
	});

	it("resolves scoped artifact URIs across session roots", async () => {
		const targetSessionId = "24c75ca4ec4b6a11"; // pragma: allowlist secret
		const targetRoot = path.join(projectDir, `2026-04-12T12-00-00-000Z_${targetSessionId}`);
		const targetPath = path.join(targetRoot, "main", "bash", "0.txt");
		await Bun.write(targetPath, "cross-session artifact\n");

		const resource = await router.resolve(`artifact://${targetSessionId}/main/bash/0.txt`);

		expect(resource.content).toBe("cross-session artifact\n");
		expect(resource.sourcePath).toBe(targetPath);
		expect(resource.url).toBe(`artifact://${targetSessionId}/main/bash/0.txt`);
	});

	it("resolves binary scoped artifacts by returning the backing source path", async () => {
		const pngPath = path.join(currentRoot, "0-FindArtifactFiles", "screenshot", "1.png");
		await Bun.write(pngPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

		const resource = await router.resolve(`artifact://${currentSessionId}/0-FindArtifactFiles/screenshot/1.png`);

		expect(resource.content).toBe("");
		expect(resource.sourcePath).toBe(pngPath);
		expect(resource.notes?.[0]).toContain("Binary artifact");
	});

	it("keeps legacy bare IDs scoped to the current agent", async () => {
		const currentAgentDir = path.join(currentRoot, "0-FindArtifactFiles");
		await Bun.write(path.join(currentRoot, "main", "bash", "2.txt"), "main agent artifact\n");
		await Bun.write(path.join(currentAgentDir, "browser", "2.txt"), "subagent artifact\n");

		const subagentRouter = new InternalUrlRouter();
		subagentRouter.register(
			new ArtifactProtocolHandler({
				getArtifactsDir: () => currentAgentDir,
			}),
		);

		const resource = await subagentRouter.resolve("artifact://2");

		expect(resource.content).toBe("subagent artifact\n");
		expect(resource.sourcePath).toBe(path.join(currentAgentDir, "browser", "2.txt"));
	});
});
