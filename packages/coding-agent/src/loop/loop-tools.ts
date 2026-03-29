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
import startDescription from "./prompts/loop-start-tool.md" with { type: "text" };

const loopStartSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	taskContent: Type.Optional(Type.String()),
	maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
	reflectEvery: Type.Optional(Type.Integer({ minimum: 0 })),
	domains: Type.Optional(Type.Array(Type.String())),
});

type LoopStartParams = Static<typeof loopStartSchema>;

const loopDoneSchema = Type.Object({
	loopId: Type.String({ minLength: 1 }),
	summary: Type.Optional(Type.String()),
	changedFiles: Type.Optional(Type.Array(Type.String())),
	findings: Type.Optional(Type.Array(Type.String())),
	forceValidate: Type.Optional(Type.Boolean()),
	taskContent: Type.Optional(Type.String()),
});

type LoopDoneParams = Static<typeof loopDoneSchema>;

export class LoopStartTool implements AgentTool<typeof loopStartSchema, { error?: boolean }, Theme> {
	readonly name = "loop_start";
	readonly label = "LoopStart";
	readonly description = renderPromptTemplate(startDescription);
	readonly parameters = loopStartSchema;
	readonly strict = true;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	renderCall(args: LoopStartParams, _options: RenderResultOptions, _theme: Theme) {
		return new Text(`LoopStart ${args.name}`, 0, 0);
	}

	async execute(
		_toolCallId: string,
		params: LoopStartParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<{ error?: boolean }>> {
		if (!this.#session.loopManager) {
			return { content: [{ type: "text", text: "Loop manager unavailable" }], details: { error: true } };
		}
		const loop = await this.#session.loopManager.start({
			name: params.name,
			taskContent: params.taskContent,
			maxIterations: params.maxIterations,
			reflectEvery: params.reflectEvery,
			domains: params.domains,
		});
		return { content: [{ type: "text", text: JSON.stringify({ loopId: loop.id, state: loop.state }) }] };
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
		});
		return { content: [{ type: "text", text: JSON.stringify({ loopId: loop.id, state: loop.state }) }] };
	}

	renderResult(result: AgentToolResult) {
		return new Text(result.content.map(part => (part.type === "text" ? part.text : "")).join(""), 0, 0);
	}
}
