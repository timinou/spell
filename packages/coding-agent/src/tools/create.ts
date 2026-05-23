import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { executeCodePath } from "@oh-my-pi/pi-natives";
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
import { resolveCwdRelativePath } from "./path-resolution";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";
import { sessionContextOpts } from "./codepath-session";

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

		// cwd-prefix duplication guard: catches the silent-nesting bug where the
		// agent passes a path containing the cwd's tail segments (e.g. cwd
		// `/proj/apps/foo` + path `apps/foo/lib/x.ts` → would resolve to
		// `/proj/apps/foo/apps/foo/lib/x.ts`). resolveCwdRelativePath auto-coalesces
		// when on-disk evidence supports the bug-pattern interpretation, and emits
		// a warning we surface in the success text. Legit nested dirs are kept.
		// Degenerate (path == cwd-tail) is the only hard-reject case.
		const resolved = resolveCwdRelativePath(sessionCwd, params.path, { mode: "file" });
		if (resolved.decision === "degenerate") {
			const r = toolResult<CreateToolResultDetails>({
				path: params.path,
				error: "cwd_prefix_duplication",
			})
				.text(resolved.warning ?? "cwd_prefix_duplication")
				.done();
			r.isError = true;
			return r;
		}
		const resolvedPath = resolved.path;

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
		// FEAT-703: pass `force` so the shrink guard is skipped when the
		// caller deliberately wants to replace a large file with a tiny
		// one. Parse-regression guard stays on either way.
		if (params.force && isCodeToolSupportedPath(resolvedPath)) {
   const guard = await evaluateWriteGuards(resolvedPath, content, { force: params.force === true });
			if ("ok" in guard && guard.ok === false) {
				return toolResult<CreateToolResultDetails>({ path: params.path, error: guard.code })
					.text(guard.detail)
					.done();
			}
		}

		// Ensure parent directory exists before delegating to kernel.
		await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

		// Delegate to kernel via unified executeCodePath edit surface.
		const chunks = await executeCodePath({
			...sessionContextOpts(this.session ?? null),
			command: "edit",
			target: path.relative(sessionCwd, resolvedPath),
			actions: [{ kind: "fileCreate", content, force: params.force ?? false }],
			root: this.session.cwd,
			sessionId: this.session.getSessionId?.()?.trim() || undefined,
		});

		const diagnostics = chunks.flatMap(c => c.diagnostics);
		if (diagnostics.length > 0) {
			const message = diagnostics.map(d => `[${d.variant}] ${d.message}`).join("\n");
			return toolResult<CreateToolResultDetails>({ path: params.path, error: diagnostics[0]!.variant })
				.text(message)
				.done();
		}

		// Verify by stat — surfaces e.g. permission/quota failures the kernel
		// promise might mask, and provides byte-count display.
		const stat = await fs.stat(resolvedPath);
		// Echo BOTH the relative-to-cwd path AND the absolute resolved path.
		// This is the second half of the silent-nesting defence: even if the
		// duplication guard ever misses, the agent sees on the next turn where
		// the file actually landed and can self-correct on the next write.
		const relFromCwd = path.relative(sessionCwd, resolvedPath) || params.path;
		// Surface the duplication-coalesce warning so the agent self-corrects on the
		// next call. Without this signal, the bug pattern would recur indefinitely.
		const dupNote = resolved.warning ? `\n   ⚠ ${resolved.warning}` : "";
		return toolResult<CreateToolResultDetails>({ path: params.path, created: true, bytes: stat.size })
			.text(`Created ${relFromCwd} (${stat.size} bytes)\n   → ${resolvedPath}${dupNote}`)
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
