import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

export type GateType = "gateCmd" | "gateCommit" | "gateArtifact";

export interface GateFailure {
	gate: GateType;
	expected: string;
	detail: string;
}

export interface TrackedBashExecution {
	command: string;
	exitCode: number;
	cwd?: string;
}

export interface GateVerificationResult {
	passed: boolean;
	failures: GateFailure[];
}

const ENV_ASSIGNMENT_PATTERN = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)`;
const ENV_PREFIX_PATTERN = new RegExp(`^(?:env\\s+)?(?:(?:${ENV_ASSIGNMENT_PATTERN})\\s+)+`);
const SHELL_WRAPPER_PATTERN = /^(?:sh|bash)\s+-(?:lc|c)\s+((?:"(?:\\.|[^"])*")|(?:'(?:\\.|[^'])*'))$/;
const CWD_PREFIX_PATTERN = /^(?:cd|pushd)\s+((?:"(?:\\.|[^"])*")|(?:'(?:\\.|[^'])*')|\S+)\s*(?:&&|;)\s*/;

function unquoteShellFragment(value: string): string {
	if (value.length < 2) return value;
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1).replace(/\\([\\"'])/g, "$1");
	}
	return value;
}

function unwrapTransparentCommand(command: string): string {
	let normalized = command.trim();
	while (normalized.length > 0) {
		const shellWrapper = normalized.match(SHELL_WRAPPER_PATTERN);
		if (shellWrapper?.[1]) {
			normalized = unquoteShellFragment(shellWrapper[1]).trim();
			continue;
		}

		const envPrefix = normalized.match(ENV_PREFIX_PATTERN)?.[0];
		if (envPrefix) {
			normalized = normalized.slice(envPrefix.length).trim();
			continue;
		}

		break;
	}
	return normalized;
}

function extractCommandPreamble(command: string): { command: string; cwdPrefixes: string[] } {
	let normalized = unwrapTransparentCommand(command);
	const cwdPrefixes: string[] = [];

	while (normalized.length > 0) {
		const cwdMatch = normalized.match(CWD_PREFIX_PATTERN);
		if (!cwdMatch?.[1]) break;
		cwdPrefixes.push(unquoteShellFragment(cwdMatch[1]));
		normalized = unwrapTransparentCommand(normalized.slice(cwdMatch[0].length));
	}

	return { command: unwrapTransparentCommand(normalized), cwdPrefixes };
}

export function normalizeCommand(command: string): string {
	return extractCommandPreamble(command).command;
}

export function resolveCommandCwd(command: string, cwd: string): string {
	const { cwdPrefixes } = extractCommandPreamble(command);
	let resolvedCwd = path.resolve(cwd);
	for (const segment of cwdPrefixes) {
		resolvedCwd = path.resolve(resolvedCwd, segment);
	}
	return resolvedCwd;
}

export function matchesGateCmd(gateCmd: string, executions: TrackedBashExecution[], cwd: string): boolean {
	const normalizedGateCmd = normalizeCommand(gateCmd);
	if (normalizedGateCmd.length === 0) return false;
	const expectedCwd = resolveCommandCwd(gateCmd, cwd);

	return executions.some(execution => {
		if (execution.exitCode !== 0) return false;
		const executionCwd = execution.cwd ? path.resolve(execution.cwd) : resolveCommandCwd(execution.command, cwd);
		return normalizeCommand(execution.command) === normalizedGateCmd && executionCwd === expectedCwd;
	});
}

export function detectGitCommit(executions: TrackedBashExecution[]): boolean {
	const pattern = /\bgit\s+commit\b/;
	return executions.some(
		execution => pattern.test(execution.command) || pattern.test(normalizeCommand(execution.command)),
	);
}

/**
 * For isolated worktree execution: verify a commit landed by checking if HEAD
 * moved past the pre-run baseline rather than scanning bash history.
 * Returns false on any git error (treat absence of evidence as evidence of absence).
 */
export async function detectGitCommitInWorktree(worktreeDir: string, baselineHeadCommit: string): Promise<boolean> {
	try {
		const currentHead = (await $`git rev-parse HEAD`.cwd(worktreeDir).quiet().nothrow().text()).trim();
		return !!currentHead && currentHead !== baselineHeadCommit;
	} catch {
		return false;
	}
}

export async function verifyGateArtifact(artifactPath: string, cwd: string): Promise<boolean> {
	const resolvedPath = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(cwd, artifactPath);
	try {
		await fs.stat(resolvedPath);
		return true;
	} catch (error: unknown) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

export async function verifyGates(opts: {
	gateCmd?: string;
	gateCommit?: boolean;
	gateArtifact?: string;
	executions: TrackedBashExecution[];
	/** Parent session cwd — used when no worktree is active. */
	cwd: string;
	/**
	 * When set, artifact paths and gateCommit are resolved against the isolation
	 * worktree rather than the parent cwd / bash history.
	 */
	worktreeDir?: string;
	/** HEAD commit recorded before the task ran (required when worktreeDir is set). */
	baselineHeadCommit?: string;
}): Promise<GateVerificationResult> {
	const failures: GateFailure[] = [];

	if (opts.gateCmd && !matchesGateCmd(opts.gateCmd, opts.executions, opts.cwd)) {
		failures.push({
			gate: "gateCmd",
			expected: opts.gateCmd,
			detail: "No successful execution matched the gate command.",
		});
	}

	if (opts.gateCommit) {
		const committed = opts.baselineHeadCommit
			? await detectGitCommitInWorktree(opts.worktreeDir ?? opts.cwd, opts.baselineHeadCommit)
			: detectGitCommit(opts.executions);
		if (!committed) {
			failures.push({
				gate: "gateCommit",
				expected: "git commit",
				detail: opts.baselineHeadCommit
					? "HEAD did not advance past the pre-run baseline."
					: "No git commit execution was detected.",
			});
		}
	}

	const artifactCwd = opts.worktreeDir ?? opts.cwd;
	if (opts.gateArtifact && !(await verifyGateArtifact(opts.gateArtifact, artifactCwd))) {
		failures.push({ gate: "gateArtifact", expected: opts.gateArtifact, detail: "Gate artifact was not found." });
	}

	return { passed: failures.length === 0, failures };
}
