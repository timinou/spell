import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectEmacs } from "../src/emacs/detection";

const ELISP_DIR = new URL("../elisp", import.meta.url).pathname;
const SOCKET_WAIT_MS = 15_000;

interface LiveSession {
	socketPath: string;
	stop(): Promise<void>;
	isAlive(): boolean;
}

let tmpDir: string;
let liveSession: LiveSession | null = null;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-live-bridge-"));
	liveSession = null;
});

afterEach(async () => {
	if (liveSession?.isAlive()) {
		await liveSession.stop();
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedPlanFile(id: string): Promise<string> {
	const dir = path.join(tmpDir, "tasks", "plans");
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${id}.org`);
	await Bun.write(
		filePath,
		`#+TITLE: Sectioned plan
#+STATE: ITEM
#+CUSTOM_ID: ${id}

* Context
Old context.

* Verification
- Existing check
`,
	);
	return filePath;
}

async function waitForSocket(socketPath: string): Promise<void> {
	const deadline = Date.now() + SOCKET_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			await fs.access(socketPath);
			return;
		} catch {
			await Bun.sleep(100);
		}
	}
	throw new Error(`Timed out waiting for MCP socket: ${socketPath}`);
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex !== -1) {
				return buffer.slice(0, newlineIndex).replace(/\r$/, "");
			}
		}
	} finally {
		reader.releaseLock();
	}

	const trimmed = buffer.trim();
	if (!trimmed) {
		throw new Error("Empty response from live Emacs bridge");
	}
	return trimmed;
}

async function callLiveTool(
	socketPath: string,
	socatPath: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const proc = Bun.spawn([socatPath, "STDIO", `UNIX-CONNECT:${socketPath}`], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	proc.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`,
	);
	const responseLine = await readFirstLine(proc.stdout as ReadableStream<Uint8Array>);
	proc.kill();
	const response = JSON.parse(responseLine) as { result?: { content?: Array<{ type?: string; text?: string }> } };
	const text = response.result?.content?.find(block => block.type === "text")?.text;
	if (!text) {
		throw new Error(`Live tool ${name} returned no text block`);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

async function launchCleanEmacsBridge(emacsPath: string): Promise<LiveSession> {
	const daemonName = `spell-org-test-${crypto.randomUUID()}`;
	const socketPath = path.join(tmpDir, `mcp-${crypto.randomUUID()}.sock`);
	const proc = Bun.spawn(
		[
			emacsPath,
			"-Q",
			`--daemon=${daemonName}`,
			"--eval",
			`(add-to-list 'load-path "${ELISP_DIR}")`,
			"--eval",
			"(require 'org-tasks-mcp)",
			"--eval",
			`(mcp-server-start-unix nil "${socketPath}")`,
		],
		{
			stdout: "ignore",
			stderr: "pipe",
		},
	);

	const stderrText = new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Clean Emacs bridge failed to start: ${await stderrText}`);
	}

	await waitForSocket(socketPath);
	let alive = true;
	return {
		socketPath,
		isAlive(): boolean {
			return alive;
		},
		async stop(): Promise<void> {
			alive = false;
			const emacsclient = Bun.which("emacsclient");
			if (emacsclient) {
				await Bun.$`${emacsclient} --socket-name=${daemonName} --eval "(kill-emacs)"`.quiet().nothrow();
			}
			try {
				await fs.unlink(socketPath);
			} catch {
				// ignore
			}
		},
	};
}

describe("live Emacs bridge section update", () => {
	test(
		"real daemon + MCP bridge updates a file-level org section and returns full file content",
		async () => {
			const detection = await detectEmacs();
			if (
				!detection.found ||
				!detection.meetsMinimum ||
				!detection.socatFound ||
				!detection.path ||
				!detection.socatPath
			) {
				return;
			}

			const id = "PLAN-008-org-section-level-editing";
			const filePath = await seedPlanFile(id);
			liveSession = await launchCleanEmacsBridge(detection.path);

			const result = await callLiveTool(liveSession.socketPath, detection.socatPath, "org-edit-section", {
				file: filePath,
				custom_id: id,
				section: "Context",
				body: "Revised via live bridge.",
				mode: "replace",
			});

			expect(result.success).toBe(true);
			expect(result.file).toBe(filePath);
			expect(result.section).toBe("Context");
			expect(result.mode).toBe("replace");
			expect(result.success).toBe(true);
			expect(result.file).toBe(filePath);
			expect(result.section).toBe("Context");
			expect(result.mode).toBe("replace");

			const diskContent = await Bun.file(filePath).text();
			expect(diskContent).toContain(`#+CUSTOM_ID: ${id}`);
			expect(diskContent).toContain("* Context");
			expect(diskContent).toContain("Revised via live bridge.");
			expect(diskContent).toContain("* Verification");
			expect(diskContent).toContain("- Existing check");
		},
		{ timeout: 30000 },
	);
});
