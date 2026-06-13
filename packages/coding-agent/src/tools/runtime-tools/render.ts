/**
 * TUI renderer for runtime tools (PLAN-337).
 *
 * Shows `tool verb` with the argv that ran. A `warn`-gated verb (observe-but-
 * allow — an uncurated runner or an escape verb) is tinted with the warning
 * colour so its usage is visible at a glance before any hard gate is decided.
 */
import type { Component } from "@spell/pi-tui";
import { Text } from "@spell/pi-tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import { renderStatusLine } from "../../tui";
import { truncateToWidth } from "../render-utils";
import type { RuntimeToolDetails } from "./tool";

function argvText(details: RuntimeToolDetails | undefined): string | undefined {
	if (!details?.argv) return undefined;
	return truncateToWidth(details.argv.join(" "), 80);
}

export const runtimeToolRenderer = {
	renderCall(args: { verb?: string }, _options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Run", description: args?.verb }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: RuntimeToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const title = details?.tool ?? "run";
		const description = details ? `${details.verb} · ${argvText(details) ?? ""}`.trim() : undefined;
		const warn = details?.warn === true;

		const icon = result.isError ? "error" : warn ? "warning" : "success";
		const header = renderStatusLine({ icon, title, description }, uiTheme);

		// A warn-gated verb tints its header line so observed usage stands out.
		const headerLine = warn ? uiTheme.fg("warning", header) : header;
		const body = (result.content?.find(c => c.type === "text")?.text ?? "")
			.split("\n")
			.map(l => uiTheme.fg("toolOutput", l));
		const lines = [headerLine, ...body];
		return {
			render: (width: number) => lines.map(l => truncateToWidth(l, width)),
			invalidate() {},
		};
	},

	mergeCallAndResult: true,
};
