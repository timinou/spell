import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@spell/pi-agent-core";
import { executeCodePath } from "@spell/pi-natives";
import type { Component } from "@spell/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import createDescription from "../prompts/tools/create.md" with { type: "text" };
import { enforcePathWrite } from "../sandbox";
import { renderCodeCell, renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { isCodeToolSupportedPath } from "./code-supported-files";
import { sessionContextOpts } from "./codepath-session";
import type { CreateParams } from "./codepath-types";
import { createSchema } from "./codepath-types";
import { evaluateWriteGuards } from "./managed-buffer-guards";
import { enforceModeWrite } from "./mode-guard";
import { resolveCwdRelativePath } from "./path-resolution";
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
	// FEAT-787: pending shows the target path; result shows the cell.
	readonly mergeCallAndResult = true;

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
		const resolved = resolveCwdRelativePath(sessionCwd, params.path, {
			mode: "file",
			projectRoot: this.session.getRepoRoot?.() ?? undefined,
		});
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
		//
		// The tagged-union arms ({kind:"base64",data} / {kind:"bytes",artifactUri})
		// are discriminated on `kind`. Everything else is treated as a literal file
		// body: a plain string passes through; a bare object/array is JSON content
		// the arg-coercion layer parsed string→value (e.g. a `package.json` body the
		// model emitted as a JSON object) — we re-serialise it rather than crash on
		// the missing discriminator (was: `router.canHandle(undefined)` → throw).
		let content: string;
		const rawContent = params.content as unknown;
		if (typeof rawContent === "string") {
			content = rawContent;
		} else if (rawContent && typeof rawContent === "object") {
			const tagged = rawContent as { kind?: unknown; data?: unknown; artifactUri?: unknown };
			if (tagged.kind === "base64" && typeof tagged.data === "string") {
				content = Buffer.from(tagged.data, "base64").toString("utf-8");
			} else if (tagged.kind === "bytes") {
				const router = this.session.internalRouter;
				const artifactUri = typeof tagged.artifactUri === "string" ? tagged.artifactUri : undefined;
				if (!artifactUri || !router?.canHandle(artifactUri)) {
					const r = toolResult<CreateToolResultDetails>({ path: params.path, error: "invalid_artifact_uri" })
						.text(`Cannot resolve artifact URI: ${artifactUri ?? "(missing)"}`)
						.done();
					r.isError = true;
					return r;
				}
				const resource = await router.resolve(artifactUri);
				content = resource.content;
			} else {
				// Untagged object/array: JSON body coerced away from string. Serialise
				// back with stable 2-space indentation (matches conventional config files).
				content = `${JSON.stringify(rawContent, null, 2)}\n`;
			}
		} else {
			const r = toolResult<CreateToolResultDetails>({ path: params.path, error: "invalid_content" })
				.text(
					`Cannot create file: content must be a string, base64, or artifact payload (got ${rawContent === null ? "null" : typeof rawContent}).`,
				)
				.done();
			r.isError = true;
			return r;
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
		// FUP-133: echo the new file's lean `#outline` (symbol-first `file::Symbol`
		// rows) so the user sees the shape that landed and the agent gets ready-made
		// CodePath handles for follow-up edits — same symbol-first affordance the
		// read surface uses. Gated to non-empty code-supported files.
		const outline = await this.#outlineOf(relFromCwd, content);
		const outlineNote = outline ? `\n\n${outline}` : "";
		return toolResult<CreateToolResultDetails>({ path: params.path, created: true, bytes: stat.size })
			.text(`Created ${relFromCwd} (${stat.size} bytes)\n   → ${resolvedPath}${dupNote}${outlineNote}`)
			.done();
	}

	/**
	 * FUP-133: resolve the lean `#outline` of a just-created file. Returns the
	 * kernel's symbol-first structural map, or null when the file is empty, not
	 * code-supported, or the outline came back empty/errored (best-effort: a
	 * confirmation nicety must never fail the create).
	 */
	async #outlineOf(relPath: string, content: string): Promise<string | null> {
		if (content.trim().length === 0 || !isCodeToolSupportedPath(relPath)) return null;
		try {
			const chunks = await executeCodePath({
				...sessionContextOpts(this.session ?? null),
				command: "get",
				target: `${relPath}#outline`,
				root: this.session.cwd,
			});
			if (chunks.some(c => c.diagnostics.length > 0)) return null;
			const node = chunks.flatMap(c => c.nodes).find(n => n.kind === "§outline");
			const text = node?.content?.text ?? node?.content?.value;
			return text && text.trim().length > 0 ? text : null;
		} catch {
			return null;
		}
	}

	renderCall(args: unknown, options: RenderResultOptions, theme: unknown): Component {
		const uiTheme = theme as Theme;
		const createPath = (args as CreateParams | undefined)?.path;
		const line = renderStatusLine(
			{
				icon: options.isPartial ? "pending" : "success",
				spinnerFrame: options.spinnerFrame,
				title: this.label,
				description: createPath,
			},
			uiTheme,
		);
		return { render: () => [line], invalidate: () => {} };
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		const uiTheme = theme as Theme;
		const details = result.details as CreateToolResultDetails | undefined;
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text?: string }).text ?? "")
			.join("\n");
		const sanitized = replaceTabs(text);
		const maxChars = 2_000;
		const truncated = sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}\n...truncated` : sanitized;
		const createPath = details?.path;
		const title = createPath ? `${this.label}  ${createPath}` : this.label;
		const metaParts: string[] = [];
		if (typeof details?.bytes === "number") metaParts.push(`${details.bytes} B`);
		if (details?.exists && !details?.created) metaParts.push("exists");
		return {
			render: (width: number) =>
				renderCodeCell(
					{
						code: truncated,
						language: "text",
						title,
						metaParts,
						status: result.isError ? "error" : "complete",
						expanded: options.expanded,
						width,
					},
					uiTheme,
				),
			invalidate: () => {},
		};
	}
}
