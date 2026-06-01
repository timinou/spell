/**
 * Status tool — kernel observability.
 *
 * Renamed from `manage`. Drops save/diff/buffers/context/undo/redo:
 *   save    — edits auto-persist (no buffer surface)
 *   undo    — moved to `edit { operations: [{ action: { kind: "undo" } }] }`
 *   redo    — moved to `edit` likewise
 *   diff    — use `find { target: "<path>#diff" }` (post W8 kernel rebuild)
 *   buffers — no buffer surface
 *   context — agent-side
 *
 * Remaining commands: languages, index, watcherStatus, lockStatus, status.
 *
 * Implementation is a thin envelope over the existing ManageTool dispatch.
 * REMOVE_AT_WAVE_11: collapse into direct executeCodePath call once
 * ManageTool is deleted.
 */

import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@spell/pi-agent-core";
import type { Component } from "@spell/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import statusDescription from "../prompts/tools/status.md" with { type: "text" };
import type { StatusParams } from "./codepath-types";
import { statusSchema } from "./codepath-types";
import { ManageTool } from "./manage";

export class StatusTool implements AgentTool<typeof statusSchema> {
	readonly name = "status";
	readonly label = "Status";
	readonly description = statusDescription;
	readonly parameters = statusSchema;
	readonly lenientArgValidation = true;

	private readonly delegate: ManageTool;

	constructor() {
		this.delegate = new ManageTool();
	}

	execute(
		toolCallId: string,
		params: StatusParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		// Schema-restricted command set. Delegate to the kernel via ManageTool.
		return this.delegate.execute(toolCallId, params, signal, onUpdate, context);
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		return this.delegate.renderResult(result, options, theme);
	}
}
