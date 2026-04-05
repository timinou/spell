import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

export type GateType = "gateCmd" | "gateCommit" | "gateArtifact";

export interface GateFailure {
	gate: GateType;
	expected: string;
	detail: string;
}

export interface TrackedBashExecution {
	command: string;
	exitCode: number;
}

export interface GateVerificationResult {
	passed: boolean;
	failures: GateFailure[];
}

export function normalizeCommand(command: string): string {
	let normalized = command.trim();
	if (normalized.length === 0) return normalized;

	const prefixPattern = /^(?:cd|pushd)\s+\S+\s*[;&]+\s*/;
	while (prefixPattern.test(normalized)) {
		normalized = normalized.replace(prefixPattern, "").trim();
	}
	return normalized;
}

export function matchesGateCmd(gateCmd: string, executions: TrackedBashExecution[]): boolean {
	const normalizedGateCmd = normalizeCommand(gateCmd);
	if (normalizedGateCmd.length === 0) return false;
	return executions.some(execution => {
		if (execution.exitCode !== 0) return false;
		return normalizeCommand(execution.command).includes(normalizedGateCmd);
	});
}

export function detectGitCommit(executions: TrackedBashExecution[]): boolean {
	return executions.some(execution => /\bgit\s+commit\b/.test(execution.command));
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
	cwd: string;
}): Promise<GateVerificationResult> {
	const failures: GateFailure[] = [];

	if (opts.gateCmd && !matchesGateCmd(opts.gateCmd, opts.executions)) {
		failures.push({
			gate: "gateCmd",
			expected: opts.gateCmd,
			detail: "No successful execution matched the gate command.",
		});
	}

	if (opts.gateCommit && !detectGitCommit(opts.executions)) {
		failures.push({ gate: "gateCommit", expected: "git commit", detail: "No git commit execution was detected." });
	}

	if (opts.gateArtifact && !(await verifyGateArtifact(opts.gateArtifact, opts.cwd))) {
		failures.push({ gate: "gateArtifact", expected: opts.gateArtifact, detail: "Gate artifact was not found." });
	}

	return { passed: failures.length === 0, failures };
}
