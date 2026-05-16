/**
 * Regression test for BUG-375: command-substitution deadlock in brush-core
 * when invoked from the napi `Shell` (persistent-session) path.
 *
 * Pre-fix, `invoke_command_in_subshell_and_get_output` used
 * `tokio::task::spawn_blocking(|| rt.block_on(...))` + a synchronous
 * `std::io::read_to_string` to drain the cmd-sub pipe. From the napi runtime
 * (where this test runs), the sync read pinned the calling tokio worker, the
 * inner child's `wait()` never resolved (SIGCHLD delivery starved through
 * shared signal-driver contention), and the pipe never reached EOF. The bash
 * tool's 305 s watchdog was the only thing that broke the hang in
 * production.
 *
 * Post-fix (AsyncPipeReader + plain `tokio::spawn`), the same pattern
 * completes near-instantly.
 *
 * The cargo-test equivalent of this test did NOT reproduce the deadlock —
 * the bug is sensitive to the napi runtime's worker configuration, so the
 * regression test must run through the real binding.
 */

import { describe, expect, it } from "bun:test";
import { Shell } from "../src/shell";

const PER_CALL_MS = 5_000;
const ITERATIONS = 8;

async function runWithBudget(shell: Shell, command: string): Promise<string> {
	let captured = "";
	const ac = new AbortController();
	const watchdog = setTimeout(() => ac.abort(), PER_CALL_MS);
	try {
		const result = await shell.run({ command, signal: ac.signal }, (err, chunk) => {
			if (!err) captured += chunk;
		});
		if (result.timedOut || result.cancelled) {
			throw new Error(
				`BUG-375 regression: command exceeded ${PER_CALL_MS} ms (timedOut=${result.timedOut} cancelled=${result.cancelled}): ${command}`,
			);
		}
		expect(result.exitCode).toBe(0);
		return captured;
	} finally {
		clearTimeout(watchdog);
	}
}

describe("BUG-375 brush-core command-substitution deadlock", () => {
	it("external command followed by cmdsub does not deadlock", async () => {
		const shell = new Shell();
		for (let i = 0; i < ITERATIONS; i++) {
			const command = `/bin/true; /bin/echo "trial-${i}=$(/bin/echo ${i})"`;
			const out = await runWithBudget(shell, command);
			expect(out).toContain(`trial-${i}=${i}`);
		}
	}, 60_000);

	it("redirect followed by cmdsub does not deadlock", async () => {
		const shell = new Shell();
		const tmp = `/tmp/bug-375-${process.pid}-${Date.now()}`;
		try {
			for (let i = 0; i < ITERATIONS; i++) {
				const command = `printf 'iter-${i}\\n' > ${tmp}; echo "size-${i}=$(/usr/bin/stat -c%s ${tmp})"`;
				const out = await runWithBudget(shell, command);
				expect(out).toMatch(new RegExp(`size-${i}=\\d+`));
			}
		} finally {
			await shell.run({ command: `rm -f ${tmp}` }).catch(() => {});
		}
	}, 60_000);

	it("loop with many externals + cmdsubs completes", async () => {
		const shell = new Shell();
		const command = `for i in 1 2 3 4 5 6 7 8 9 10; do /bin/true && echo "trial$i=$(/bin/echo $i)"; done`;
		const out = await runWithBudget(shell, command);
		for (let i = 1; i <= 10; i++) {
			expect(out).toContain(`trial${i}=${i}`);
		}
	}, 30_000);
});
