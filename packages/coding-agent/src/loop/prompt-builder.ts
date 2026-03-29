import { renderPromptTemplate } from "../config/prompt-templates";
import iterationPrompt from "./prompts/iteration.md" with { type: "text" };
import reflectionPrompt from "./prompts/reflection.md" with { type: "text" };
import type { LoopPromptContext } from "./types";

export function buildIterationPrompt(context: LoopPromptContext): string {
	return renderPromptTemplate(iterationPrompt, context);
}

export function buildReflectionPrompt(context: LoopPromptContext): string {
	return renderPromptTemplate(reflectionPrompt, context);
}
