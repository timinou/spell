import { renderPromptTemplate } from "../config/prompt-templates";
import iterationPrompt from "./prompts/iteration.md" with { type: "text" };
import reflectionPrompt from "./prompts/reflection.md" with { type: "text" };
import type { LoopPromptContext, LoopSnapshot } from "./types";

export function buildIterationPrompt(context: LoopPromptContext): string {
	return renderPromptTemplate(iterationPrompt, context);
}

export function buildReflectionPrompt(context: LoopPromptContext): string {
	return renderPromptTemplate(reflectionPrompt, context);
}

export function buildManifestPromptContext(snapshot: LoopSnapshot): Partial<LoopPromptContext> {
	if (!snapshot.manifest) return {};
	const { tickets } = snapshot.manifest;
	const doneCount = tickets.filter(t => t.state === "DONE").length;
	const doingCount = tickets.filter(t => t.state === "DOING").length;
	const blockedCount = tickets.filter(t => t.state === "BLOCKED").length;
	const doneIds = new Set(tickets.filter(t => t.state === "DONE").map(t => t.id));
	return {
		manifestTickets: tickets.map(t => ({
			id: t.id,
			title: t.title,
			state: t.state,
			dependencies: t.dependencies,
			hasGates: t.gates.length > 0,
			effort: t.effort,
			priority: t.priority,
		})),
		manifestProgress: `${doneCount}/${tickets.length} done, ${doingCount} active, ${blockedCount} blocked`,
		readyTickets: tickets
			.filter(t => t.state === "ITEM" && t.dependencies.every(dep => doneIds.has(dep)))
			.map(t => t.id),
		activeTickets: tickets.filter(t => t.state === "DOING").map(t => t.id),
		completedTickets: tickets.filter(t => t.state === "DONE").map(t => t.id),
		manifestComplete: tickets.every(t => t.state === "DONE"),
	};
}
