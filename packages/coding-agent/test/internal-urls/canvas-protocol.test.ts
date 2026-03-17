import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CanvasProtocolHandler,
	InternalUrlRouter,
	resolveCanvasRoots,
	resolveCanvasUrlToPath,
} from "../../src/internal-urls";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function createRouter(options: {
	stdlibRoot: string;
	artifactsDir?: string | null;
	sessionId?: string | null;
}): InternalUrlRouter {
	const router = new InternalUrlRouter();
	router.register(
		new CanvasProtocolHandler({
			getStdlibRoot: () => options.stdlibRoot,
			getArtifactsDir: () => options.artifactsDir ?? null,
			getSessionId: () => options.sessionId ?? null,
		}),
	);
	return router;
}

describe("CanvasProtocolHandler", () => {
	it("resolves canvas://session files from session root and reads after write", async () => {
		await withTempDir(async tempDir => {
			const stdlibRoot = path.join(tempDir, "stdlib");
			const artifactsDir = path.join(tempDir, "artifacts");
			const sessionFile = resolveCanvasUrlToPath(
				"canvas://session/views/test.qml",
				{
					getStdlibRoot: () => stdlibRoot,
					getArtifactsDir: () => artifactsDir,
					getSessionId: () => "session-a",
				},
				"write",
			);
			await Bun.write(sessionFile, "import QtQuick 2.15");

			const router = createRouter({ stdlibRoot, artifactsDir, sessionId: "session-a" });
			const resource = await router.resolve("canvas://session/views/test.qml");
			expect(resource.sourcePath).toBe(path.join(artifactsDir, "canvas", "views", "test.qml"));
			expect(resource.content).toContain("QtQuick");
		});
	});

	it("rejects unknown namespace and path traversal", async () => {
		await withTempDir(async tempDir => {
			const stdlibRoot = path.join(tempDir, "stdlib");
			const artifactsDir = path.join(tempDir, "artifacts");
			const router = createRouter({ stdlibRoot, artifactsDir, sessionId: "session-b" });

			await expect(router.resolve("canvas://unknown/file.qml")).rejects.toThrow(
				"Unknown canvas:// namespace: unknown. Available: stdlib, session",
			);
			expect(() =>
				resolveCanvasUrlToPath("canvas://session/../secrets.qml", {
					getStdlibRoot: () => stdlibRoot,
					getArtifactsDir: () => artifactsDir,
					getSessionId: () => "session-b",
				}),
			).toThrow("Path traversal (..) is not allowed in canvas:// URLs");
			await expect(router.resolve("canvas://session/%2E%2E/secrets.qml")).rejects.toThrow(
				"Path traversal (..) is not allowed in canvas:// URLs",
			);
		});
	});

	it("resolves write path before file exists and keeps stdlib read-only for write intent", async () => {
		await withTempDir(async tempDir => {
			const stdlibRoot = path.join(tempDir, "stdlib");
			const artifactsDir = path.join(tempDir, "artifacts");
			const roots = resolveCanvasRoots({
				getStdlibRoot: () => stdlibRoot,
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-c",
			});

			const target = resolveCanvasUrlToPath(
				"canvas://session/new/panel.qml",
				{
					getStdlibRoot: () => stdlibRoot,
					getArtifactsDir: () => artifactsDir,
					getSessionId: () => "session-c",
				},
				"write",
			);
			expect(target).toBe(path.join(roots.sessionRoot, "new", "panel.qml"));
			expect(await Bun.file(target).exists()).toBe(false);

			expect(() =>
				resolveCanvasUrlToPath(
					"canvas://stdlib/CanvasLauncher.qml",
					{
						getStdlibRoot: () => stdlibRoot,
						getArtifactsDir: () => artifactsDir,
						getSessionId: () => "session-c",
					},
					"write",
				),
			).toThrow("canvas://stdlib is read-only");
		});
	});

	it("keeps canvas://stdlib reads working", async () => {
		await withTempDir(async tempDir => {
			const stdlibRoot = path.join(tempDir, "stdlib");
			const stdlibFile = path.join(stdlibRoot, "CanvasLauncher.qml");
			await fs.mkdir(path.dirname(stdlibFile), { recursive: true });
			await Bun.write(stdlibFile, "import QtQuick 2.15");
			const router = createRouter({ stdlibRoot, artifactsDir: path.join(tempDir, "artifacts"), sessionId: "d" });

			const resource = await router.resolve("canvas://stdlib/CanvasLauncher.qml");
			expect(resource.sourcePath).toBe(stdlibFile);
			expect(resource.content).toContain("QtQuick");
		});
	});
});
