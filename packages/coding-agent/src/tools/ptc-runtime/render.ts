/**
 * TUI renderer for the `execute` tool.
 *
 * Most execute results are a single value rendered as plain text. The one shape
 * that benefits from structured rendering is a `(probe ...)` result: an ordered
 * list of titled checks. The runtime surfaces those as `details.probe`
 * (`ProbeRow[]`), so this renderer reads clean data — titles + values — instead
 * of re-parsing the formatted `<probe>` text, and lays each check out as a
 * titled block (intention header + indented evidence).
 */
import type { Component } from "@spell/pi-tui";
import { Ellipsis, Text } from "@spell/pi-tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import { renderStatusLine } from "../../tui";
import { formatCount, formatErrorMessage, truncateToWidth } from "../render-utils";
import type { ProbeRow } from "./execute";

interface ExecuteRenderArgs {
	program?: string;
}

interface ExecuteToolDetails {
	program?: string;
	probe?: ProbeRow[];
	durationMs?: number;
}

/** First non-blank line of the program, for the call header. */
function programSnippet(program: string | undefined): string | undefined {
	if (!program) return undefined;
	const firstLine = program.split("\n").find(l => l.trim().length > 0)?.trim();
	return firstLine ? truncateToWidth(firstLine, 60) : undefined;
}

/** Render one probe value (scalar inline, structured as pretty JSON). */
function probeValueLines(value: unknown, theme: Theme): string[] {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return text.split("\n").map(line => `  ${theme.fg("toolOutput", line)}`);
}

export const executeToolRenderer = {
	renderCall(args: ExecuteRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = programSnippet(args?.program);
		const text = renderStatusLine({ icon: "pending", title: "Execute", description }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ExecuteToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: ExecuteRenderArgs,
	): Component {
		const details = result.details;
		const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
		const description = programSnippet(details?.program ?? args?.program);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Execute", description }, uiTheme);
			const lines = [header, formatErrorMessage(textContent, uiTheme)];
			return {
				render: () => lines,
				invalidate() {},
			};
		}

		const probe = details?.probe;
		if (probe && probe.length > 0) {
			// Titled blocks: each check's title is its intention, the value its
			// evidence indented beneath. This is the visual form of the <probe> text.
			const header = renderStatusLine(
				{ icon: "success", title: "Execute", description, meta: [formatCount("check", probe.length)] },
				uiTheme,
			);
			const blocks: string[] = [];
			for (const { title, value } of probe) {
				blocks.push(uiTheme.fg("accent", `▸ ${title}`));
				blocks.push(...probeValueLines(value, uiTheme));
			}
			const lines = [header, ...blocks];
			return {
				render: (width: number) => lines.map(l => truncateToWidth(l, width, Ellipsis.Omit)),
				invalidate() {},
			};
		}

		// Non-probe result: a single value. Header + the plain text body.
		const header = renderStatusLine({ icon: "success", title: "Execute", description }, uiTheme);
		const bodyLines = textContent.split("\n").map(l => uiTheme.fg("toolOutput", l));
		const lines = [header, ...bodyLines];
		return {
			render: (width: number) => lines.map(l => truncateToWidth(l, width, Ellipsis.Omit)),
			invalidate() {},
		};
	},

	mergeCallAndResult: true,
};
