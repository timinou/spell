import type { GateDecision } from "../../contracts";
import { GATE_OUTCOMES } from "../../contracts";
import type { CommandGateConfig } from "../../types";
import type { GateExecutionContext, GateExecutor } from "../types";

async function readStreamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return new Response(stream).text();
}

export class CommandGateExecutor implements GateExecutor<CommandGateConfig> {
	async execute(gate: CommandGateConfig, context: GateExecutionContext): Promise<GateDecision> {
		const child = Bun.spawn(["bash", "-lc", gate.command], {
			cwd: gate.cwd ?? context.cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const timeoutMs = gate.timeoutMs ?? 0;
		const exitResult =
			timeoutMs > 0
				? await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => "timeout")])
				: await child.exited;
		if (exitResult === "timeout") {
			child.kill();
			return {
				gateId: gate.id,
				trigger: gate.trigger.kind,
				outcome: GATE_OUTCOMES.fail,
				reason: `Command gate timed out after ${timeoutMs}ms`,
				evidence: [],
				attemptNumber: context.attemptNumber,
				maxAttempts: gate.maxAttempts ?? 1,
			};
		}
		const stdout = (await readStreamText(child.stdout)).trim();
		const stderr = (await readStreamText(child.stderr)).trim();
		const evidence = [stdout, stderr].filter(Boolean);
		if (exitResult !== 0) {
			return {
				gateId: gate.id,
				trigger: gate.trigger.kind,
				outcome: GATE_OUTCOMES.fail,
				reason: stderr || `Command gate exited with code ${exitResult}`,
				evidence,
				attemptNumber: context.attemptNumber,
				maxAttempts: gate.maxAttempts ?? 1,
			};
		}
		if (gate.passPattern && !new RegExp(gate.passPattern).test(stdout)) {
			return {
				gateId: gate.id,
				trigger: gate.trigger.kind,
				outcome: GATE_OUTCOMES.fail,
				reason: `Command output did not match pass pattern ${gate.passPattern}`,
				evidence,
				attemptNumber: context.attemptNumber,
				maxAttempts: gate.maxAttempts ?? 1,
			};
		}
		return {
			gateId: gate.id,
			trigger: gate.trigger.kind,
			outcome: GATE_OUTCOMES.pass,
			reason: stdout || "Command gate passed",
			evidence,
			attemptNumber: context.attemptNumber,
			maxAttempts: gate.maxAttempts ?? 1,
		};
	}
}
