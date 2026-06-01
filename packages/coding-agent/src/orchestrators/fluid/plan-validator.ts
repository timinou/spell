import * as ai from "@spell/pi-ai";
import { logger } from "@spell/pi-utils";
import { renderPromptTemplate } from "../../config/prompt-templates";
import fluidPlanValidatorPrompt from "../../prompts/agents/fluid-plan-validator.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import type { FluidPlan } from "./types";

export interface SemanticPlanValidationResult {
	valid: boolean;
	critique?: string;
}

function extractTextContent(message: ai.Message): string {
	if (typeof message.content === "string") {
		return message.content.trim();
	}
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

function parseValidationPayload(text: string): SemanticPlanValidationResult | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	const jsonPayload = trimmed.startsWith("{") ? trimmed : (trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "");
	if (jsonPayload.length === 0) {
		return undefined;
	}

	const parsed = JSON.parse(jsonPayload) as { valid?: unknown; critique?: unknown };
	if (typeof parsed.valid !== "boolean") {
		return undefined;
	}

	if (parsed.valid) {
		return { valid: true };
	}

	if (typeof parsed.critique === "string" && parsed.critique.trim().length > 0) {
		return { valid: false, critique: parsed.critique.trim() };
	}
	return {
		valid: false,
		critique: "Plan failed semantic validation. Make task outputs clearer and dependencies more logical.",
	};
}

export async function validatePlanSemantic(
	session: AgentSession,
	plan: FluidPlan,
	userPrompt: string,
	signal?: AbortSignal,
): Promise<SemanticPlanValidationResult> {
	const model = session.resolveRoleModel("smol") ?? session.model;
	if (!model) {
		logger.warn("Skipping semantic plan validation because no model is available");
		return { valid: true };
	}

	const apiKey = await session.modelRegistry.getApiKey(model, session.sessionId);
	if (!apiKey) {
		logger.warn("Skipping semantic plan validation because no API key is configured", {
			provider: model.provider,
			model: model.id,
		});
		return { valid: true };
	}

	const userMessage = renderPromptTemplate(fluidPlanValidatorPrompt, {
		userPrompt,
		planJson: JSON.stringify(plan, null, 2),
	});

	try {
		const response = await ai.completeSimple(
			model,
			{
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
			},
			{ apiKey, maxTokens: 400, signal },
		);

		if (response.stopReason === "error") {
			logger.warn("Semantic plan validation failed; proceeding without semantic gate", {
				error: response.errorMessage,
			});
			return { valid: true };
		}

		const parsed = parseValidationPayload(extractTextContent(response));
		if (!parsed) {
			logger.warn("Semantic plan validator returned non-JSON or invalid payload; proceeding", {
				response: extractTextContent(response),
			});
			return { valid: true };
		}

		return parsed;
	} catch (err) {
		if (signal?.aborted) {
			return { valid: true };
		}
		logger.warn("Semantic plan validation threw; proceeding without semantic gate", {
			error: err instanceof Error ? err.message : String(err),
		});
		return { valid: true };
	}
}
