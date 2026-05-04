import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderCodeCell } from "../tui";
import type { ToolSession } from ".";
import { formatCodePathResult } from "./codepath-result";
import type { CreateParams } from "./codepath-types";
import { createSchema } from "./codepath-types";
import { replaceTabs } from "./render-utils";
import { toolResult } from "./tool-result";

export class CreateTool implements AgentTool<typeof createSchema> {
	readonly name = "create";
	readonly label = "Create";
	readonly description = "Create a new file with text, bytes from an artifact URI, or base64-encoded content.";
	readonly parameters = createSchema;
	readonly lenientArgValidation = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CreateParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const resolvedPath = path.isAbsolute(params.path) ? params.path : path.resolve(this.session.cwd, params.path);

		// Reject if file exists and force is not set
		if (!params.force) {
			const exists = await fs.exists(resolvedPath);
			if (exists) {
				return toolResult({ path: params.path, exists: true })
					.text(`File already exists: ${params.path}. Use force=true to overwrite.`)
					.done();
			}
		}

		let content: string;
		if (typeof params.content === "string") {
			content = params.content;
		} else if (params.content.kind === "base64") {
			content = Buffer.from(params.content.data, "base64").toString("utf-8");
		} else {
			// bytes from artifact URI
			const router = this.session.internalRouter;
			if (!router?.canHandle(params.content.artifactUri)) {
				return toolResult({ path: params.path, error: "invalid_artifact_uri" })
					.text(`Cannot resolve artifact URI: ${params.content.artifactUri}`)
					.done();
			}
			const resource = await router.resolve(params.content.artifactUri);
			content = resource.content;
		}

		// Lower to codepath edit with create action
		const chunks = await executeCodePath({
			command: "edit",
			target: resolvedPath,
			actions: [{ kind: "create", content, force: params.force }],
			abortSignal: signal,
		});

		const result = formatCodePathResult(chunks, { format: "node-list" });
		const text = result.text || `Created ${params.path}`;
		return toolResult({ path: params.path, created: true }).text(text).done();
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		const uiTheme = theme as Theme;
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text?: string }).text ?? "")
			.join("\n");
		const sanitized = replaceTabs(text);
		const maxChars = 2_000;
		const truncated = sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}\n...truncated` : sanitized;
		return {
			render: (width: number) =>
				renderCodeCell(
					{
						code: truncated,
						language: "text",
						title: "Create",
						status: "complete",
						expanded: options.expanded,
						width,
					},
					uiTheme,
				),
			invalidate: () => {},
		};
	}
}
