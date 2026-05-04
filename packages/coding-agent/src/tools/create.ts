import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import createDescription from "../prompts/tools/create.md" with { type: "text" };
import { enforcePathWrite } from "../sandbox";
import { renderCodeCell } from "../tui";
import type { ToolSession } from ".";
import { isCodeToolSupportedPath } from "./code-supported-files";
import type { CreateParams } from "./codepath-types";
import { createSchema } from "./codepath-types";
import { evaluateWriteGuards } from "./managed-buffer-guards";
import { enforceModeWrite } from "./mode-guard";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";

type CreateToolResultDetails = DetailsWithMeta & {
	path?: string;
	exists?: boolean;
	error?: string;
	created?: boolean;
	bytes?: number;
};

export class CreateTool implements AgentTool<typeof createSchema> {
	readonly name = "create";
	readonly label = "Create";
	readonly description = createDescription;
	readonly parameters = createSchema;
	readonly lenientArgValidation = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CreateParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const sessionCwd = this.session.cwd;
		const resolvedPath = path.isAbsolute(params.path) ? params.path : path.resolve(sessionCwd, params.path);

		// Mode + sandbox guards (throw on violation, mirroring edit.ts).
		enforceModeWrite(this.session, resolvedPath, { op: "create" });
		const sandboxError = enforcePathWrite(resolvedPath, sessionCwd, this.session.sandboxPolicy);
		if (sandboxError) throw new Error(sandboxError);

		// Reject existing file unless force overwrite is requested.
		if (!params.force) {
			if (await fs.exists(resolvedPath)) {
				return toolResult<CreateToolResultDetails>({ path: params.path, exists: true })
					.text(`File already exists: ${params.path}. Use force=true to overwrite.`)
					.done();
			}
		}

		// Resolve content payload (string | base64 | artifact URI).
		let content: string;
		if (typeof params.content === "string") {
			content = params.content;
		} else if (params.content.kind === "base64") {
			content = Buffer.from(params.content.data, "base64").toString("utf-8");
		} else {
			const router = this.session.internalRouter;
			if (!router?.canHandle(params.content.artifactUri)) {
				return toolResult<CreateToolResultDetails>({ path: params.path, error: "invalid_artifact_uri" })
					.text(`Cannot resolve artifact URI: ${params.content.artifactUri}`)
					.done();
			}
			const resource = await router.resolve(params.content.artifactUri);
			content = resource.content;
		}

		// Managed-buffer guards (shrink + parse-regression) only when overwriting an
		// existing code-supported file. A brand-new file has nothing to compare against.
		if (params.force && isCodeToolSupportedPath(resolvedPath)) {
			const guard = evaluateWriteGuards(resolvedPath, content);
			if ("ok" in guard && guard.ok === false) {
				return toolResult<CreateToolResultDetails>({ path: params.path, error: guard.code })
					.text(guard.detail)
					.done();
			}
		}

		// Persist to disk. Ensure parent dir, write atomically through node fs.
		await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
		await fs.writeFile(resolvedPath, content, "utf-8");

		// Verify by stat — surfaces e.g. permission/quota failures the writeFile
		// promise might mask.
		const stat = await fs.stat(resolvedPath);
		return toolResult<CreateToolResultDetails>({ path: params.path, created: true, bytes: stat.size })
			.text(`Created ${params.path} (${stat.size} bytes)`)
			.done();
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
