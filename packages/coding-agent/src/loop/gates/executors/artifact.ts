import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { GATE_OUTCOMES } from "../../contracts";
import type { ArtifactGateConfig } from "../../types";
import type { GateExecutionContext, GateExecutor } from "../types";

export class ArtifactGateExecutor implements GateExecutor<ArtifactGateConfig> {
	async execute(gate: ArtifactGateConfig, context: GateExecutionContext) {
		const artifactPath = path.isAbsolute(gate.path) ? gate.path : path.join(context.cwd, gate.path);
		try {
			await fs.stat(artifactPath);
		} catch {
			return {
				gateId: gate.id,
				trigger: gate.trigger.kind,
				outcome: GATE_OUTCOMES.fail,
				reason: `Artifact not found: ${artifactPath}`,
				evidence: [],
				attemptNumber: context.attemptNumber,
				maxAttempts: gate.maxAttempts ?? 1,
			};
		}
		const text = await Bun.file(artifactPath).text();
		if (gate.regex && !new RegExp(gate.regex).test(text)) {
			return {
				gateId: gate.id,
				trigger: gate.trigger.kind,
				outcome: GATE_OUTCOMES.fail,
				reason: `Artifact content did not match ${gate.regex}`,
				evidence: [artifactPath],
				attemptNumber: context.attemptNumber,
				maxAttempts: gate.maxAttempts ?? 1,
			};
		}
		if (gate.jsonSchema) {
			const parsed = JSON.parse(text) as unknown;
			if (!Value.Check(gate.jsonSchema, parsed)) {
				return {
					gateId: gate.id,
					trigger: gate.trigger.kind,
					outcome: GATE_OUTCOMES.fail,
					reason: "Artifact JSON did not match schema",
					evidence: [artifactPath],
					attemptNumber: context.attemptNumber,
					maxAttempts: gate.maxAttempts ?? 1,
				};
			}
		}
		return {
			gateId: gate.id,
			trigger: gate.trigger.kind,
			outcome: GATE_OUTCOMES.pass,
			reason: `Artifact present: ${artifactPath}`,
			evidence: [artifactPath],
			attemptNumber: context.attemptNumber,
			maxAttempts: gate.maxAttempts ?? 1,
		};
	}
}
