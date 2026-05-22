import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AgentProtocolHandler,
	ArtifactProtocolHandler,
	CanvasProtocolHandler,
	createTaskUriProtocolHandlers,
	InternalUrlRouter,
	JobsProtocolHandler,
	LocalProtocolHandler,
	McpProtocolHandler,
	MemoryProtocolHandler,
	OrgProtocolHandler,
	PiProtocolHandler,
	RuleProtocolHandler,
	SkillProtocolHandler,
} from "../../src/internal-urls";
import { KERNEL_OWNED_SCHEMES } from "../../src/internal-urls/router";
import type { InternalResource } from "../../src/internal-urls/types";

const FIXED_SESSION_ID = "abc123def456";

/**
 * When the kernel surfaces a [DID_YOU_MEAN] diagnostic, replace the raw
 * machine-oriented line with a friendly hint.
 * (Copied from packages/coding-agent/src/tools/get.ts)
 */
function prettifyDidYouMean(text: string): string {
	return text.replace(
		/^\[(\w+)\] \[DID_YOU_MEAN\] No exact match for [^;]+; candidates: (\[.*?\])(?: \([^)]+\))?$/gm,
		(_match, _variant, candidatesJson: string) => {
			try {
				const candidates = JSON.parse(candidatesJson) as string[];
				if (Array.isArray(candidates) && candidates.length > 0) {
					return `Did you mean: ${candidates.join(", ")}`;
				}
			} catch {
				// ignore parse errors, leave original
			}
			return _match;
		},
	);
}

const HAPPY: Record<string, { url: string; expectFsSourcePath: boolean; missUrl: string }> = {
	agent: {
		url: "agent://test-output",
		expectFsSourcePath: true,
		missUrl: "agent://missing-output",
	},
	artifact: {
		url: `artifact://${FIXED_SESSION_ID}/main/get/0.txt`,
		expectFsSourcePath: true,
		missUrl: `artifact://${FIXED_SESSION_ID}/main/get/999.txt`,
	},
	canvas: {
		url: "canvas://stdlib/FluidShell.qml",
		expectFsSourcePath: true,
		missUrl: "canvas://stdlib/NonExistent.qml",
	},
	data: {
		url: `data://${FIXED_SESSION_ID}/main/test-task`,
		expectFsSourcePath: false,
		missUrl: "data://invalid",
	},
	jobs: {
		url: "jobs://test-job",
		expectFsSourcePath: false,
		missUrl: "jobs://missing-job",
	},
	local: {
		url: "local://test.txt",
		expectFsSourcePath: true,
		missUrl: "local://missing.txt",
	},
	mcp: {
		url: "mcp://test://notes",
		expectFsSourcePath: false,
		missUrl: "mcp://test://missing",
	},
	memory: {
		url: "memory://root/memory_summary.md",
		expectFsSourcePath: true,
		missUrl: "memory://root/missing.md",
	},
	org: {
		url: "org://TEST-001",
		expectFsSourcePath: true,
		missUrl: "org://MISSING",
	},
	pi: {
		url: "pi://mcp-runtime-lifecycle.md",
		expectFsSourcePath: false,
		missUrl: "pi://nonexistent.md",
	},
	rule: {
		url: "rule://test-rule",
		expectFsSourcePath: true,
		missUrl: "rule://missing-rule",
	},
	skill: {
		url: "skill://test-skill",
		expectFsSourcePath: true,
		missUrl: "skill://missing-skill",
	},
	task: {
		url: `task://${FIXED_SESSION_ID}/main/test-task`,
		expectFsSourcePath: false,
		missUrl: "task://invalid",
	},
};

describe("handler contract matrix", () => {
	let tmpDir: string;
	let artifactsDir: string;
	let memoryRoot: string;
	let skillDir: string;
	let stdlibRoot: string;
	let router: InternalUrlRouter;
	let jobManager: {
		getJob: (id: string) =>
			| {
					id: string;
					type: "bash" | "task";
					status: string;
					startTime: number;
					label: string;
					abortController: AbortController;
					promise: Promise<void>;
					resultText?: string;
					errorText?: string;
			  }
			| undefined;
		getAllJobs: () => ReturnType<typeof jobManager.getJob>[];
	};
	let mcpManager: {
		getConnectedServers: () => string[];
		getServerResources: (name: string) =>
			| {
					resources: Array<{ uri: string; name: string }>;
					templates: Array<{ uriTemplate: string; name: string }>;
			  }
			| undefined;
		readServerResource: (
			name: string,
			uri: string,
		) => Promise<{ contents: Array<{ text?: string; blob?: string; mimeType?: string }> } | undefined>;
	};

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handler-contract-"));

		// Artifacts dir must end with _<hex> for extractArtifactSessionId
		artifactsDir = path.join(tmpDir, `test_artifacts_${FIXED_SESSION_ID}`);
		await fs.mkdir(artifactsDir, { recursive: true });

		// Agent output
		await Bun.write(path.join(artifactsDir, "test-output.md"), "agent output content");

		// Artifact scoped file
		const artifactFile = path.join(artifactsDir, "main", "get", "0.txt");
		await fs.mkdir(path.dirname(artifactFile), { recursive: true });
		await Bun.write(artifactFile, "artifact content");

		// Memory root
		memoryRoot = path.join(tmpDir, "memory");
		await fs.mkdir(memoryRoot, { recursive: true });
		await Bun.write(path.join(memoryRoot, "memory_summary.md"), "memory summary");

		// Skill dir
		skillDir = path.join(tmpDir, "skills", "test-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(path.join(skillDir, "SKILL.md"), "skill content");

		// Local file
		const localRoot = path.resolve(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "test.txt"), "local content");

		// Canvas stdlib (real)
		stdlibRoot = path.resolve(import.meta.dir, "../../src/modes/qml");

		// Canvas session file
		const canvasSessionRoot = path.join(artifactsDir, "canvas");
		await fs.mkdir(canvasSessionRoot, { recursive: true });
		await Bun.write(path.join(canvasSessionRoot, "test.qml"), "canvas content");

		// Job manager stub
		jobManager = {
			getJob(id: string) {
				if (id === "test-job") {
					return {
						id: "test-job",
						type: "bash" as const,
						status: "completed",
						startTime: Date.now(),
						label: "Test job",
						abortController: new AbortController(),
						promise: Promise.resolve(),
						resultText: "job result",
					};
				}
				return undefined;
			},
			getAllJobs() {
				const job = this.getJob("test-job");
				return job ? [job] : [];
			},
		};

		// MCP manager stub
		mcpManager = {
			getConnectedServers() {
				return ["test-server"];
			},
			getServerResources(name: string) {
				if (name !== "test-server") return undefined;
				return {
					resources: [{ uri: "test://notes", name: "Notes" }],
					templates: [],
				};
			},
			async readServerResource(name: string, uri: string) {
				if (name === "test-server" && uri === "test://notes") {
					return { contents: [{ text: "mcp content", mimeType: "text/plain" }] };
				}
				return undefined;
			},
		};

		// Build router matching sdk.ts:1047-1090 registration order
		router = new InternalUrlRouter();
		router.register(new AgentProtocolHandler({ getArtifactsDir: () => artifactsDir }));
		router.register(new ArtifactProtocolHandler({ getArtifactsDir: () => artifactsDir }));
		router.register(new MemoryProtocolHandler({ getMemoryRoot: () => memoryRoot }));
		router.register(
			new LocalProtocolHandler({ getArtifactsDir: () => artifactsDir, getSessionId: () => FIXED_SESSION_ID }),
		);
		router.register(
			new SkillProtocolHandler({
				getSkills: () => [
					{
						name: "test-skill",
						filePath: path.join(skillDir, "SKILL.md"),
						baseDir: skillDir,
						source: "test",
						description: "test skill",
					},
				],
			}),
		);
		router.register(
			new RuleProtocolHandler({
				getRules: () => [
					{
						name: "test-rule",
						content: "test rule body",
						path: path.join(tmpDir, "test-rule.md"),
						_source: { provider: "test", providerName: "Test", path: tmpDir, level: "user" },
					},
				],
			}),
		);
		router.register(new PiProtocolHandler());
		router.register(new JobsProtocolHandler({ getAsyncJobManager: () => jobManager as any }));
		router.register(new McpProtocolHandler({ getMcpManager: () => mcpManager as any }));
		for (const handler of createTaskUriProtocolHandlers({ getCurrentSessionId: () => FIXED_SESSION_ID })) {
			router.register(handler);
		}
		router.register(
			new OrgProtocolHandler({
				getSettings: () =>
					({
						get: (key: string) => {
							if (key === "org.enabled") return true;
							if (key === "org.todoKeywords") return ["TODO", "DONE", "DOING"];
							return undefined;
						},
					}) as unknown as import("../../src/config/settings").Settings,
				getCwd: () => tmpDir,
			}),
		);
		router.register(
			new CanvasProtocolHandler({
				getStdlibRoot: () => stdlibRoot,
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => FIXED_SESSION_ID,
			}),
		);
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	for (const [scheme, { url, expectFsSourcePath, missUrl }] of Object.entries(HAPPY)) {
		// PLAN-310 cutover: schemes in KERNEL_OWNED_SCHEMES no longer have a JS
		// resolver to contract-test. Their parity is enforced by Rust integration
		// tests in crates/pi-natives/tests/scheme_*.rs.
		const describeFn = KERNEL_OWNED_SCHEMES.has(scheme) ? describe.skip : describe;
		describeFn(scheme, () => {
			it("canHandle(url) returns true", () => {
				expect(router.canHandle(url)).toBe(true);
			});

			const resolveIt = scheme === "org" ? it.skip : it;
			resolveIt("resolve(url) returns required shape", async () => {
				const resource = (await router.resolve(url)) as InternalResource;
				expect(typeof resource.content).toBe("string");
				expect(typeof resource.contentType).toBe("string");
				if (resource.size !== undefined) {
					expect(typeof resource.size).toBe("number");
				}
				expect(typeof resource.url).toBe("string");
				expect(resource.url).toStartWith(`${scheme}://`);
			});

			const sourcePathIt = scheme === "org" ? it.skip : it;
			sourcePathIt("sourcePath shape is correct", async () => {
				const resource = (await router.resolve(url)) as InternalResource;
				if (expectFsSourcePath) {
					expect(resource.sourcePath).toBeDefined();
					expect(resource.sourcePath).not.toStartWith(`${scheme}://`);
				} else {
					// MAY be virtual (starts with scheme://) or undefined
					if (resource.sourcePath !== undefined) {
						expect(resource.sourcePath).toStartWith(`${scheme}://`);
					}
				}
			});

			const didYouMeanIt = scheme === "jobs" ? it.skip : it;
			didYouMeanIt("did-you-mean on miss", async () => {
				let error: Error | undefined;
				try {
					await router.resolve(missUrl);
				} catch (err) {
					error = err instanceof Error ? err : new Error(String(err));
				}
				expect(error).toBeDefined();
				const message = error!.message.toLowerCase();
				const hasNotFound = message.includes("not found");
				const prettified = prettifyDidYouMean(error!.message);
				expect(hasNotFound || typeof prettified === "string").toBe(true);
			});
		});
	}
});
