import { type Static, Type } from "@sinclair/typebox";

export const canvasOutputSchema = Type.Object({
	type: Type.Union([
		Type.Literal("markdown"),
		Type.Literal("table"),
		Type.Literal("diff"),
		Type.Literal("tree"),
		Type.Literal("log"),
		Type.Literal("code"),
		Type.Literal("progress"),
	]),
	title: Type.String({ description: "Display title for the canvas component" }),
});

export const fluidAgentNodeSchema = Type.Object({
	id: Type.String({ description: "Unique kebab-case identifier for this agent" }),
	task: Type.String({ description: "The full assignment/prompt for this agent to execute" }),
	dependsOn: Type.Array(Type.String(), {
		description: "IDs of upstream agents whose output this agent needs as context",
		default: [],
	}),
	canvasOutput: Type.Optional(canvasOutputSchema),
});

export const fluidPlanSchema = Type.Object({
	agents: Type.Array(fluidAgentNodeSchema, {
		description: "Ordered list of agent nodes forming a directed acyclic graph",
	}),
});

export type FluidPlanOutput = Static<typeof fluidPlanSchema>;
