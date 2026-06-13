/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */
import type { Component } from "@spell/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";

import type { Theme } from "../modes/theme/theme";
import { editToolRenderer } from "../patch";
import { taskToolRenderer } from "../task/render";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";

import { bashToolRenderer } from "./bash";
import { calculatorToolRenderer } from "./calculator";
import { fetchToolRenderer } from "./fetch";
import { inspectImageToolRenderer } from "./inspect-image-renderer";
import { executeToolRenderer } from "./ptc-runtime/render";
import { resolveToolRenderer } from "./resolve";
import { runtimeToolRenderer } from "./runtime-tools/render";
import { searchToolBm25Renderer } from "./search-tool-bm25";
import { sshToolRenderer } from "./ssh";
import { todoWriteToolRenderer } from "./todo-write";

type ToolRenderer = {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	mergeCallAndResult?: boolean;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
};

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,

	bash: bashToolRenderer as ToolRenderer,
	terminal: bashToolRenderer as ToolRenderer, // PLAN-337: same PTY-style output display

	calc: calculatorToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	execute: executeToolRenderer as ToolRenderer,
	git: runtimeToolRenderer as ToolRenderer,
	run: runtimeToolRenderer as ToolRenderer,

	inspect_image: inspectImageToolRenderer as ToolRenderer,

	resolve: resolveToolRenderer as ToolRenderer,
	search_tool_bm25: searchToolBm25Renderer as ToolRenderer,
	ssh: sshToolRenderer as ToolRenderer,
	task: taskToolRenderer as ToolRenderer,
	todo_write: todoWriteToolRenderer as ToolRenderer,
	fetch: fetchToolRenderer as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
};
