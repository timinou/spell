import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import {
	AgentProtocolHandler,
	InternalUrlRouter,
	JobsProtocolHandler,
	LocalProtocolHandler,
	MemoryProtocolHandler,
} from "../../src/internal-urls";
import { GetTool } from "../../src/tools/get";
import type { ToolSession } from "../../src/tools/index";

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("");
}

describe("URI/codepath syntax conformance", () => {
	let tmpDir: string;
	let artifactsDir: string;
	let memoryRoot: string;
	let router: InternalUrlRouter;
	let getTool: GetTool;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "uri-syntax-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });

		// Case 1: agent output with JSON content for path extraction
		await Bun.write(path.join(artifactsDir, "X.md"), JSON.stringify({ foo: ["bar"] }));

		// Case 2: memory summary file (must be under cwd so relative path works)
		memoryRoot = path.resolve(process.cwd(), "tmp-memory-root");
		await fs.mkdir(memoryRoot, { recursive: true });
		await Bun.write(path.join(memoryRoot, "memory_summary.md"), "LINE_ONE\nLINE_TWO\nLINE_THREE");

		// Case 4: local scratch file
		const localRoot = path.resolve(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "MY_PLAN.md"), "# My Plan\n\nSome content here.\n");

		// Case 3: job manager stub
		const jobManager = {
			getJob(id: string) {
				if (id === "test-id") {
					return {
						id: "test-id",
						type: "bash" as const,
						status: "completed",
						startTime: Date.now(),
						label: "Test job",
						abortController: new AbortController(),
						promise: Promise.resolve(),
						resultText: "STDOUT_CONTENT",
						errorText: "STDERR_CONTENT",
					};
				}
				return undefined;
			},
			getAllJobs() {
				const job = this.getJob("test-id");
				return job ? [job] : [];
			},
		};

		router = new InternalUrlRouter();
		router.register(new AgentProtocolHandler({ getArtifactsDir: () => artifactsDir }));
		router.register(new MemoryProtocolHandler({ getMemoryRoot: () => memoryRoot }));
		router.register(
			new LocalProtocolHandler({
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "test-session",
			}),
		);
		router.register(new JobsProtocolHandler({ getAsyncJobManager: () => jobManager as any }));

		const mockSession: ToolSession = {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			internalRouter: router,
			settings: Settings.isolated(),
		};

		getTool = new GetTool(mockSession);
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		await fs.rm(memoryRoot, { recursive: true, force: true }).catch(() => {});
	});

	it.skip("[PLAN-310: kernel-owned via §agent] agent://X/foo/0 path-form jq extraction", async () => {
		// Behavior tested in crates/pi-natives/tests/scheme_e2e_w4.rs::
		//   execute_code_path_agent_path_form_extracts_via_jq
		return;
	});

	it.skip("[legacy] agent://X/foo/0 — path-form jq extraction (no :: suffix)", async () => {
		// agent://X/.foo[0] would be the jq query, but the agent protocol's
		// path form maps /foo/0 → .foo[0]; the whole string has no ::
		const result = await getTool.execute("test-1", { target: "agent://X/foo/0" });
		expect(result.isError).toBeFalsy();
		const text = resultText(result);
		expect(text).toContain('"bar"');
	});

	it.skip("[PLAN-310: kernel-owned via §memory] memory://root::§line[2..2] suffix forwarded", async () => {
		// Test relied on JS-side getMemoryRoot config. Kernel uses
		// project_root/.spell/memory; behavior validated in
		// crates/pi-natives/tests/scheme_e2e_w4.rs::
		//   execute_code_path_forwards_suffix_to_source_path
		return;
	});

	it.skip("[legacy] memory://root::§line[2..2] — preempt + suffix forwarded to kernel", async () => {
		const result = await getTool.execute("test-2", { target: "memory://root::§line[2..2]" });
		expect(result.isError).toBeFalsy();
		const text = resultText(result);
		expect(text).toContain("LINE_TWO");
		expect(text).not.toContain("LINE_ONE");
	});

	it.skip("jobs://test-id#stdout — fragment routing not implemented", async () => {
		// TODO(BUG-TBD): jobs:// fragment routing not implemented
		const result = await getTool.execute("test-3", { target: "jobs://test-id#stdout" });
		expect(result.isError).toBeFalsy();
		const text = resultText(result);
		expect(text).toContain("STDOUT_CONTENT");
		expect(text).not.toContain("STDERR_CONTENT");
	});

	it.skip("[PLAN-310: kernel-owned via §local] local://MY_PLAN.md::App.handle suffix forwarded", async () => {
		// Kernel computes session root differently than the JS handler;
		// behavior covered by scheme_registry_w1.rs local_* tests.
		return;
	});

	it.skip("[legacy] local://MY_PLAN.md::App.handle — suffix forwarded; kernel returns diagnostic", async () => {
		const result = await getTool.execute("test-4", { target: "local://MY_PLAN.md::App.handle" });
		expect(result.content.length).toBeGreaterThan(0);
		const text = resultText(result);
		expect(text.length).toBeGreaterThan(0);
		// Accept either a kernel diagnostic or a [note] about ignored suffix
		const hasDiagnostic = text.includes("[") || text.includes("parser") || text.includes("DID_YOU_MEAN");
		const hasNote = text.includes("[note]");
		expect(hasDiagnostic || hasNote).toBe(true);
	});
});
