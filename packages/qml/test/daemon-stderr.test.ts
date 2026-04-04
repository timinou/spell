/**
 * Tests for QML daemon stderr diagnostics.
 *
 * Contracts:
 * 1. When the daemon fails to start, stderr output is included in the error message.
 * 2. Only the last N lines of stderr are included (bounded).
 *
 * Isolated in its own file because Bun.spawn subprocess handles
 * prevent the test process from exiting when combined with socket tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QmlProcess } from "../src/qml-process";

describe("QmlProcess - daemon stderr diagnostics", () => {
	let tmpDir: string;
	let sockPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-qml-daemon-stderr-"));
		sockPath = path.join(tmpDir, "missing.sock");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function createFakeDaemon(lines: string[]): Promise<string> {
		const binaryPath = path.join(tmpDir, "fake-spell-qml-bridge.sh");
		const stderrScript = lines.map(line => `echo ${JSON.stringify(line)} 1>&2`).join("\n");
		const script = `#!/bin/sh\n${stderrScript}\nexit 1\n`;
		await fs.writeFile(binaryPath, script);
		await fs.chmod(binaryPath, 0o755);
		return binaryPath;
	}

	it("includes daemon stderr output when daemon spawn cannot establish a socket", async () => {
		const binaryPath = await createFakeDaemon(["daemon startup failed", "missing display backend"]);
		const originalSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc = new QmlProcess({ binaryPath });
		try {
			let thrown: Error | null = null;
			try {
				await proc.ensure();
			} catch (err) {
				thrown = err instanceof Error ? err : new Error(String(err));
			}
			expect(thrown).not.toBeNull();
			const message = thrown?.message ?? "";
			expect(message).toContain("Failed to connect to daemon socket after spawn");
			expect(message).toContain("Daemon stderr:");
			expect(message).toContain("daemon startup failed");
			expect(message).toContain("missing display backend");
		} finally {
			QmlProcess.socketPath = originalSocketPath;
			await proc.dispose();
		}
	});

	it("keeps only the last 50 daemon stderr lines in diagnostics", async () => {
		const allLines = Array.from({ length: 55 }, (_, idx) => `diag-${String(idx + 1).padStart(3, "0")}`);
		const binaryPath = await createFakeDaemon(allLines);
		const originalSocketPath = QmlProcess.socketPath;
		QmlProcess.socketPath = () => sockPath;

		const proc = new QmlProcess({ binaryPath });
		try {
			let thrown: Error | null = null;
			try {
				await proc.ensure();
			} catch (err) {
				thrown = err instanceof Error ? err : new Error(String(err));
			}
			expect(thrown).not.toBeNull();
			const message = thrown?.message ?? "";
			expect(message).toContain("diag-055");
			expect(message).toContain("diag-006");
			expect(message).not.toContain("diag-001");
			expect(message).not.toContain("diag-005");
		} finally {
			QmlProcess.socketPath = originalSocketPath;
			await proc.dispose();
		}
	});
});
