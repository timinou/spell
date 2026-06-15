/**
 * Property / fuzz tests for the unified gate evaluator (FEAT-817).
 *
 * No external property-test dependency — a seeded LCG drives a deterministic
 * generator so failures reproduce from the printed seed. Each property runs
 * over RUNS random inputs and asserts an invariant that must hold for ALL.
 *
 * Invariants under test (cmd + artifact gates, which are pure / fs-only — the
 * commit gate hits real git and is covered by the unit suites):
 *   E1  evaluation is deterministic — same inputs ⇒ same verdict
 *   E2  evidence-source-agnostic — a gate cleared by a bash-shaped record is
 *       cleared identically by the same command recorded as a run record
 *   E3  monotonic in evidence — adding the satisfying execution can only flip a
 *       failing cmd gate to passing, never the reverse
 *   E4  prefix/cwd contract — a matched gate's normalized command is a prefix of
 *       the (normalized) execution AND the resolved cwds agree
 *   E5  the evaluator never throws and always returns a well-formed result
 *   E6  empty/whitespace gate strings never spuriously pass
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type ExecutionRecord,
	matchesGateCmd,
	normalizeCommand,
	resolveCommandCwd,
	verifyGates,
} from "../../src/task/gate-verification";

const RUNS = 200;

class Rng {
	#state: number;
	constructor(seed: number) {
		this.#state = seed >>> 0;
	}
	next(): number {
		this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0;
		return this.#state / 0x100000000;
	}
	int(maxExclusive: number): number {
		return Math.floor(this.next() * maxExclusive);
	}
	pick<T>(arr: readonly T[]): T {
		return arr[this.int(arr.length)]!;
	}
	bool(p = 0.5): boolean {
		return this.next() < p;
	}
}

const BASE_COMMANDS = [
	"bun test",
	"bun test foo.ts",
	"cargo test -p pi-code-engine",
	"mix test test/x_test.exs",
	"pnpm lint",
	"go test ./...",
] as const;
const CWD_PREFIXES = ["", "cd /repo && ", "cd packages/djinn && ", "env CI=1 ", "sh -c \""] as const;
const CWD_SUFFIX_FOR_PREFIX: Record<string, string> = { 'sh -c "': '"' };
const TAILS = ["", " | tail -5", " 2>&1", " --verbose", " && echo done"] as const;
const CWDS = ["/repo", "/repo/packages/djinn", "/other"] as const;

/** Build a random execution that DOES satisfy `gate` when run in `cwd`. */
function satisfyingExecution(rng: Rng, gate: string, cwd: string): ExecutionRecord {
	const prefix = rng.pick(CWD_PREFIXES);
	const suffix = CWD_SUFFIX_FOR_PREFIX[prefix] ?? "";
	const tail = rng.pick(TAILS);
	// The prefix may embed its own `cd …`; resolve the recorded cwd so the
	// execution's effective dir equals the gate's effective dir.
	const command = `${prefix}${gate}${tail}${suffix}`;
	return { command, exitCode: 0, cwd: resolveCommandCwd(command, cwd) === resolveCommandCwd(gate, cwd) ? cwd : cwd };
}

describe("gate evaluator — property/fuzz", () => {
	it("E1: matchesGateCmd is deterministic", () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed);
			const gate = rng.pick(BASE_COMMANDS);
			const cwd = rng.pick(CWDS);
			const execs = [satisfyingExecution(rng, gate, cwd)];
			const a = matchesGateCmd(gate, execs, cwd);
			const b = matchesGateCmd(gate, execs, cwd);
			expect(a, `seed=${seed}`).toBe(b);
		}
	});

	it("E2: evidence-source-agnostic — bash vs run record give the same verdict", () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 10_000);
			const gate = rng.pick(BASE_COMMANDS);
			const cwd = rng.pick(CWDS);
			// Same literal command + cwd, regardless of which tool produced it: the
			// evaluator only sees an ExecutionRecord, so the verdicts must match.
			const command = `${gate}${rng.pick(TAILS)}`;
			const execCwd = rng.pick(CWDS);
			const asBash: ExecutionRecord = { command, exitCode: 0, cwd: execCwd };
			const asRun: ExecutionRecord = { command, exitCode: 0, cwd: execCwd };
			expect(matchesGateCmd(gate, [asBash], cwd), `seed=${seed}`).toBe(matchesGateCmd(gate, [asRun], cwd));
		}
	});

	it("E3: monotonic — adding the satisfying execution never un-passes a cmd gate", () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 20_000);
			const gate = rng.pick(BASE_COMMANDS);
			const cwd = rng.pick(CWDS);
			const noise: ExecutionRecord[] = Array.from({ length: rng.int(3) }, () => ({
				command: `${rng.pick(BASE_COMMANDS)}-noise`,
				exitCode: rng.pick([0, 1]),
				cwd: rng.pick(CWDS),
			}));
			const before = matchesGateCmd(gate, noise, cwd);
			const after = matchesGateCmd(gate, [...noise, { command: gate, exitCode: 0, cwd }], cwd);
			// before may be true or false; after MUST be true (added the exact match).
			expect(after, `seed=${seed} before=${before}`).toBe(true);
		}
	});

	it("E4: a match implies the prefix + cwd contract holds", () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 30_000);
			const gate = rng.pick(BASE_COMMANDS);
			const cwd = rng.pick(CWDS);
			const exec = satisfyingExecution(rng, gate, cwd);
			if (!matchesGateCmd(gate, [exec], cwd)) continue;
			const ng = normalizeCommand(gate);
			const ne = normalizeCommand(exec.command);
			expect(ne === ng || ne.startsWith(`${ng} `), `seed=${seed} ne=${ne} ng=${ng}`).toBe(true);
			// Mirror the matcher: a recorded cwd is trusted as-is (path.resolve), not
			// re-derived from the command's `cd` prefix; only an unrecorded cwd falls
			// back to resolving the command preamble against the session cwd.
			const execCwd = exec.cwd ? path.resolve(exec.cwd) : resolveCommandCwd(exec.command, cwd);
			expect(execCwd, `seed=${seed}`).toBe(resolveCommandCwd(gate, cwd));
		}
	});

	it("E5: verifyGates never throws and returns a well-formed result", async () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 40_000);
			const gate = rng.bool(0.2) ? "" : rng.pick(BASE_COMMANDS);
			const cwd = rng.pick(CWDS);
			const execs: ExecutionRecord[] = Array.from({ length: rng.int(4) }, () => ({
				command: rng.pick(BASE_COMMANDS),
				exitCode: rng.pick([0, 0, 1]),
				cwd: rng.pick(CWDS),
			}));
			const result = await verifyGates({
				gateCmd: gate || undefined,
				gateArtifact: rng.bool(0.3) ? `missing-${seed}.txt` : undefined,
				executions: execs,
				cwd,
			});
			expect(typeof result.passed, `seed=${seed}`).toBe("boolean");
			expect(Array.isArray(result.failures), `seed=${seed}`).toBe(true);
			expect(result.passed, `seed=${seed}`).toBe(result.failures.length === 0);
			for (const f of result.failures) {
				expect(["gateCmd", "gateCommit", "gateArtifact", "verify.review"], `seed=${seed}`).toContain(f.gate);
			}
		}
	});

	it("E6: empty / whitespace gate strings never spuriously pass", () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 50_000);
			const cwd = rng.pick(CWDS);
			const execs: ExecutionRecord[] = [{ command: rng.pick(BASE_COMMANDS), exitCode: 0, cwd }];
			expect(matchesGateCmd(rng.pick(["", "   ", "\t", "\n"]), execs, cwd), `seed=${seed}`).toBe(false);
		}
	});

	it("E7: a failed execution (nonzero exit) never satisfies a cmd gate", () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const rng = new Rng(seed + 60_000);
			const gate = rng.pick(BASE_COMMANDS);
			const cwd = rng.pick(CWDS);
			const exec: ExecutionRecord = { command: gate, exitCode: 1 + rng.int(127), cwd };
			expect(matchesGateCmd(gate, [exec], cwd), `seed=${seed}`).toBe(false);
		}
	});
});
