import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
} from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { Theme } from "../modes/theme/theme";
import type { ToolSession } from "../tools";
import doneDescription from "./prompts/loop-done-tool.md" with { type: "text" };
import launchDescription from "./prompts/loop-launch-tool.md" with { type: "text" };
import prepareDescription from "./prompts/loop-prepare-tool.md" with { type: "text" };

const loopPrepareSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	specPaths: Type.Optional(Type.Array(Type.String())),
	taskContent: Type.Optional(Type.String()),
	maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
	reflectEvery: Type.Optional(Type.Integer({ minimum: 0 })),
	domains: Type.Optional(Type.Array(Type.String())),
});

type LoopPrepareParams = Static<typeof loopPrepareSchema>;

const loopLaunchSchema = Type.Object({
	loopId: Type.String({ minLength: 1 }),
});

type LoopLaunchParams = Static<typeof loopLaunchSchema>;

const loopDoneSchema = Type.Object({
	loopId: Type.String({ minLength: 1 }),
	summary: Type.Optional(Type.String()),
	changedFiles: Type.Optional(Type.Array(Type.String())),
	findings: Type.Optional(Type.Array(Type.String())),
	forceValidate: Type.Optional(Type.Boolean()),
	taskContent: Type.Optional(Type.String()),
	completedTickets: Type.Optional(Type.Array(Type.String())),
	activeTickets: Type.Optional(Type.Array(Type.String())),
});

type LoopDoneParams = Static<typeof loopDoneSchema>;

export class LoopPrepareTool implements AgentTool<typeof loopPrepareSchema, { error?: boolean }, Theme> {
	readonly name = "loop_prepare";
	readonly label = "LoopPrepare";
	readonly description = renderPromptTemplate(prepareDescription);
	readonly parameters = loopPrepareSchema;
	readonly strict = true;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	renderCall(args: LoopPrepareParams, _options: RenderResultOptions, _theme: Theme) {
		return new Text(`LoopPrepare ${args.name}`, 0, 0);
	}

	async execute(
		_toolCallId: string,
		params: LoopPrepareParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<{ error?: boolean }>> {
		if (!this.#session.loopManager) {
			return { content: [{ type: "text", text: "Loop manager unavailable" }], details: { error: true } };
		}
		const loop = await this.#session.loopManager.prepare({
			name: params.name,
			specPaths: params.specPaths,
			taskContent: params.taskContent,
			maxIterations: params.maxIterations,
			reflectEvery: params.reflectEvery,
			domains: params.domains,
		});
		const result: Record<string, unknown> = { loopId: loop.id, state: loop.state };
		if (!loop.gitAvailable) {
			result.warning =
				"Git repository unavailable; git features (checkpoints, drift detection, worktrees) are disabled.";
		}
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	}

	renderResult(result: AgentToolResult) {
		return new Text(result.content.map(part => (part.type === "text" ? part.text : "")).join(""), 0, 0);
	}
}

export class LoopLaunchTool implements AgentTool<typeof loopLaunchSchema, { error?: boolean }, Theme> {
	readonly name = "loop_launch";
	readonly label = "LoopLaunch";
	readonly description = renderPromptTemplate(launchDescription);
	readonly parameters = loopLaunchSchema;
	readonly strict = true;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	renderCall(args: LoopLaunchParams, _options: RenderResultOptions, _theme: Theme) {
		return new Text(`LoopLaunch ${args.loopId}`, 0, 0);
	}

	async execute(
		_toolCallId: string,
		params: LoopLaunchParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<{ error?: boolean }>> {
		if (!this.#session.loopManager) {
			return { content: [{ type: "text", text: "Loop manager unavailable" }], details: { error: true } };
		}
		try {
			const loop = await this.#session.loopManager.launch(params.loopId);
			return { content: [{ type: "text", text: JSON.stringify({ loopId: loop.id, state: loop.state }) }] };
		} catch (err) {
			return {
				content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
				details: { error: true },
			};
		}
	}

	renderResult(result: AgentToolResult) {
		return new Text(result.content.map(part => (part.type === "text" ? part.text : "")).join(""), 0, 0);
	}
}

export class LoopDoneTool implements AgentTool<typeof loopDoneSchema, { error?: boolean }, Theme> {
	readonly name = "loop_done";
	readonly label = "LoopDone";
	readonly description = renderPromptTemplate(doneDescription);
	readonly parameters = loopDoneSchema;
	readonly strict = true;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	renderCall(args: LoopDoneParams, _options: RenderResultOptions, _theme: Theme) {
		return new Text(`LoopDone ${args.loopId}`, 0, 0);
	}

	async execute(
		_toolCallId: string,
		params: LoopDoneParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<{ error?: boolean }>> {
		if (!this.#session.loopManager) {
			return { content: [{ type: "text", text: "Loop manager unavailable" }], details: { error: true } };
		}
		const loop = await this.#session.loopManager.markDone(params.loopId, {
			summary: params.summary,
			changedFiles: params.changedFiles,
			findings: params.findings,
			forceValidate: params.forceValidate,
			taskContent: params.taskContent,
			completedTickets: params.completedTickets,
			activeTickets: params.activeTickets,
		});
		return { content: [{ type: "text", text: JSON.stringify({ loopId: loop.id, state: loop.state }) }] };
	}

	renderResult(result: AgentToolResult) {
		return new Text(result.content.map(part => (part.type === "text" ? part.text : "")).join(""), 0, 0);
	}
}
