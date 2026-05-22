import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const mockExecuteOrg = mock();
const realNatives = await import("@oh-my-pi/pi-natives");
mock.module("@oh-my-pi/pi-natives", () => ({ ...realNatives, executeOrg: mockExecuteOrg }));

const { InternalUrlRouter, MemoryProtocolHandler } = await import("../../src/internal-urls");

beforeEach(() => mockExecuteOrg.mockReset());

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function createRouter(memoryRoot: string): InstanceType<typeof InternalUrlRouter> {
	const router = new InternalUrlRouter();
	router.register(
		new MemoryProtocolHandler({
			getMemoryRoot: () => memoryRoot,
		}),
	);
	return router;
}

describe("MemoryProtocolHandler", () => {
	it("resolves memory://root to memory_summary.md", async () => {
		await withTempDir(async tempDir => {
			const memoryRoot = path.join(tempDir, "memory");
			await fs.mkdir(memoryRoot, { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "summary");

			const router = createRouter(memoryRoot);
			const resource = await router.resolve("memory://root");

			expect(resource.content).toBe("summary");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("resolves memory://root/<path> within memory root", async () => {
		await withTempDir(async tempDir => {
			const memoryRoot = path.join(tempDir, "memory");
			const skillPath = path.join(memoryRoot, "skills", "demo", "SKILL.md");
			await fs.mkdir(path.dirname(skillPath), { recursive: true });
			await Bun.write(skillPath, "demo skill");

			const router = createRouter(memoryRoot);
			const resource = await router.resolve("memory://root/skills/demo/SKILL.md");

			expect(resource.content).toBe("demo skill");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("throws for unknown memory namespace", async () => {
		await withTempDir(async tempDir => {
			const memoryRoot = path.join(tempDir, "memory");
			await fs.mkdir(memoryRoot, { recursive: true });

			const router = createRouter(memoryRoot);
			await expect(router.resolve("memory://other/memory_summary.md")).rejects.toThrow(
				"Unknown memory namespace: other. Supported: root",
			);
		});
	});

	it("blocks path traversal attempts", async () => {
		await withTempDir(async tempDir => {
			const memoryRoot = path.join(tempDir, "memory");
			await fs.mkdir(memoryRoot, { recursive: true });

			const router = createRouter(memoryRoot);
			await expect(router.resolve("memory://root/../secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
			await expect(router.resolve("memory://root/%2E%2E/secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
		});
	});

	it("throws clear error for missing files", async () => {
		await withTempDir(async tempDir => {
			const memoryRoot = path.join(tempDir, "memory");
			await fs.mkdir(memoryRoot, { recursive: true });

			const router = createRouter(memoryRoot);
			await expect(router.resolve("memory://root/missing.md")).rejects.toThrow(
				"Memory file not found: memory://root/missing.md",
			);
		});
	});

	it("blocks symlink escapes outside memory root", async () => {
		if (process.platform === "win32") return;

		await withTempDir(async tempDir => {
			const memoryRoot = path.join(tempDir, "memory");
			const outsideDir = path.join(tempDir, "outside");
			await fs.mkdir(memoryRoot, { recursive: true });
			await fs.mkdir(outsideDir, { recursive: true });
			await Bun.write(path.join(outsideDir, "secret.md"), "secret");
			await fs.symlink(outsideDir, path.join(memoryRoot, "linked"));

			const router = createRouter(memoryRoot);
			await expect(router.resolve("memory://root/linked/secret.md")).rejects.toThrow(
				"memory:// URL escapes memory root",
			);
		});
	});
});

describe("MemoryProtocolHandler URI forms", () => {
	it("memory://search?text=… routes to executeOrg(recall)", async () => {
		mockExecuteOrg.mockReturnValueOnce({
			error: false,
			output: { hits: [{ id: "FEAT-1", score: 0.7 }] },
		});
		const router = new InternalUrlRouter();
		router.register(
			new MemoryProtocolHandler({
				getMemoryRoot: () => "/tmp/p/.spell/memory",
				getRepoRoot: () => "/tmp/p",
			}),
		);
		const res = await router.resolve("memory://search?text=oauth&scope=concept,playbook&limit=5");
		expect(res.contentType).toBe("application/json");
		const parsed = JSON.parse(res.content) as { hits: Array<{ id: string }> };
		expect(parsed.hits[0].id).toBe("FEAT-1");
		const [args] = mockExecuteOrg.mock.calls.map(c => c[0] as Record<string, unknown>);
		expect(args.command).toBe("recall");
		expect(args.text).toBe("oauth");
		expect(args.scope).toEqual(["concept", "playbook"]);
		expect(args.limit).toBe(5);
		expect(args.repoRoot).toBe("/tmp/p");
	});

	it("memory://search throws without text or focus", async () => {
		const router = new InternalUrlRouter();
		router.register(
			new MemoryProtocolHandler({
				getMemoryRoot: () => "/tmp/p/.spell/memory",
			}),
		);
		await expect(router.resolve("memory://search")).rejects.toThrow("requires `text` or `focus`");
	});

	it("memory://item/<id> routes to executeOrg(subgraph, hops=1)", async () => {
		mockExecuteOrg.mockReturnValueOnce({
			error: false,
			output: { nodes: [{ id: "CON-x" }], edges: [] },
		});
		const router = new InternalUrlRouter();
		router.register(
			new MemoryProtocolHandler({
				getMemoryRoot: () => "/tmp/p/.spell/memory",
				getRepoRoot: () => "/tmp/p",
			}),
		);
		const res = await router.resolve("memory://item/CON-x");
		expect(res.contentType).toBe("application/json");
		const [args] = mockExecuteOrg.mock.calls.map(c => c[0] as Record<string, unknown>);
		expect(args.command).toBe("subgraph");
		expect(args.root).toBe("CON-x");
		expect(args.hops).toBe(1);
	});

	it("memory://since/<ts> returns stub payload without calling executeOrg", async () => {
		const router = new InternalUrlRouter();
		router.register(
			new MemoryProtocolHandler({
				getMemoryRoot: () => "/tmp/p/.spell/memory",
			}),
		);
		const res = await router.resolve("memory://since/2026-05-21T00:00:00Z");
		expect(res.contentType).toBe("application/json");
		const payload = JSON.parse(res.content) as { ts: string; note: string };
		expect(payload.ts).toBe("2026-05-21T00:00:00Z");
		expect(payload.note).toContain("not yet implemented");
		expect(mockExecuteOrg).not.toHaveBeenCalled();
	});

	it("memory://browse returns the TUI panel sentinel", async () => {
		const router = new InternalUrlRouter();
		router.register(
			new MemoryProtocolHandler({
				getMemoryRoot: () => "/tmp/p/.spell/memory",
			}),
		);
		const res = await router.resolve("memory://browse");
		expect(res.contentType).toBe("application/json");
		const payload = JSON.parse(res.content) as { browse: boolean; hint: string };
		expect(payload.browse).toBe(true);
		expect(payload.hint).toContain("TUI panel");
	});
});

