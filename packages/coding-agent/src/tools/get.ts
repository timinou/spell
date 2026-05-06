import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { InternalUrlRouter } from "../internal-urls";
import type { Theme } from "../modes/theme/theme";
import getDescription from "../prompts/tools/get.md" with { type: "text" };
import { renderCodeCell } from "../tui";
import { type CodePathFormatMode, formatCodePathResult } from "./codepath-result";
import type { GetParams } from "./codepath-types";
import { getSchema } from "./codepath-types";
import type { ToolSession } from "./index";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";

type GetToolResultDetails = DetailsWithMeta & {
	format?: string;
	target?: string;
	error?: string;
};

/**
 * Classifies a target for auto-attach behavior.
 * - `"bare-plain"`: plain filesystem path (no scheme, axis, qualifier, terminator, glob).
 *   Auto-attach `#raw` for files, `#listing` for dirs.
 * - `"qualified"`: has explicit qualifier (`#...`) — caller's qualifier wins.
 * - `"other"`: scheme, axis, terminator, or glob — pass through unchanged.
 */
function classifyBareTarget(target: string): "bare-plain" | "qualified" | "other" {
	if (target.includes("://")) return "other";
	if (target.includes("::")) return "other";
	if (target.includes(";")) return "other";
	if (/[*?[]/.test(target)) return "other";
	if (target.includes("#")) return "qualified";
	return "bare-plain";
}

/**
 * Builds a directory qualifier from params:
 * - `depth` → `#tree[depth=N]` (overrides recursive)
 * - `recursive` → `#tree` (full recursion)
 * - default → `#listing` (one level)
 */
function buildDirQualifier(target: string, params: GetParams): string {
	if (params.depth !== undefined) return `${target}#tree[depth=${params.depth}]`;
	if (params.recursive) return `${target}#tree`;
	return `${target}#listing`;
}

/**
 * BUG-348: detect whether an absolute path is inside the walker root.
 * The kernel's FsWalker only walks subtrees of `opts.root`; absolute
 * paths outside that subtree are silently invisible to the walker, and
 * `gitignore:false` does nothing for them. Callers need a distinct
 * diagnostic so they don't confuse "out-of-root" with "gitignored".
 */
function isInsideRoot(absPath: string, root: string): boolean {
	const normRoot = path.resolve(root);
	const normPath = path.resolve(absPath);
	if (normPath === normRoot) return true;
	return normPath.startsWith(normRoot + path.sep);
}

/**
 * FEAT-714: build a structured §no-results diagnostic with attached
 * qualifier, resolved path, and an actionable next-step hint. Replaces
 * the overloaded single-line message that conflated 6+ different
 * causes (empty outline, gitignore, out-of-root, pagination overshoot).
 */
function buildNoResults(opts: {
	target: string;
	attachedQualifier: string | null;
	resolvedAbs: string | null;
	reason: string;
	tryNext: string | null;
	evidence?: string | null;
}): string {
	const lines: string[] = [`[§no-results] ${opts.target}`];
	if (opts.attachedQualifier) lines.push(`  attached:  ${opts.attachedQualifier}`);
	if (opts.resolvedAbs) lines.push(`  resolved:  ${opts.resolvedAbs}`);
	lines.push(`  reason:    ${opts.reason}`);
	if (opts.evidence) lines.push(`  evidence:  ${opts.evidence}`);
	if (opts.tryNext) lines.push(`  try next:  ${opts.tryNext}`);
	return lines.join("\n");
}

/**
 * When the kernel surfaces a [DID_YOU_MEAN] diagnostic, replace the raw
 * machine-oriented line with a friendly hint.
 */
function prettifyDidYouMean(text: string): string {
	return text.replace(
		/^\[(\w+)\] \[DID_YOU_MEAN\] No exact match for [^;]+; candidates: (\[.*?\])(?: \([^)]+\))?$/gm,
		(_match, _variant, candidatesJson: string) => {
			try {
				const candidates = JSON.parse(candidatesJson) as string[];
				if (Array.isArray(candidates) && candidates.length > 0) {
					return `Did you mean: ${candidates.join(", ")}`;
				}
			} catch {
				// ignore parse errors, leave original
			}
			return _match;
		},
	);
}

/**
 * Schemes whose authoritative state lives in the JS process. For these the
 * Rust kernel either lacks a handler entirely (`task`, `data`, `org`, `canvas`)
 * or reads from a path that diverges from JS truth (jobs/mcp, plus
 * pi/local/memory/skill/rule/agent which all consult JS-side aggregated
 * registries or session-scoped roots).
 *
 * GetTool preempts `executeCodePath` and resolves through the session's
 * internal URL router so the response reflects live in-process state.
 *
 * Codepath qualifiers (`::§line[…]`, `::Symbol`, `::§file[…]`) are preserved:
 * when the resolved resource has a real filesystem `sourcePath`, the suffix
 * is forwarded to the kernel against that path; otherwise simple
 * head/tail/offset/limit projections are applied locally.
 */

/**
 * Split a target into URI base and codepath suffix on the `::` separator.
 * The suffix is preserved verbatim (including the leading `::`).
 */
function splitCodepath(target: string): { uriBase: string; codepathSuffix: string } {
	const idx = target.indexOf("::");
	return idx < 0
		? { uriBase: target, codepathSuffix: "" }
		: { uriBase: target.slice(0, idx), codepathSuffix: target.slice(idx) };
}

export class GetTool implements AgentTool<typeof getSchema> {
	readonly name = "get";
	readonly label = "Get";
	readonly description = getDescription;
	readonly parameters = getSchema;
	readonly lenientArgValidation = true;

	constructor(private readonly session?: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: GetParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		let target = params.target;

		// FEAT-815: schemes whose state lives in JS (in-memory job manager,
		// MCP manager, swarm task registry, org/canvas) cannot be resolved by
		// the Rust kernel — it has no live process state and (for `jobs`,
		// `mcp`) reads stale or non-existent on-disk shadows. Route them
		// through the session's internal URL router for live truth.
		const preempted = await this.tryResolveViaInternalRouter(target, params, signal);
		if (preempted) return preempted;

		// FEAT-711: a `/regex/` literal looks like bare-plain to
		// classifyBareTarget but is meant for the kernel's grep dialect.
		const looksLikeRegex = /^\/[^/]+\/[a-z]*$/.test(target) && /[.*+?()|\\[\]]/.test(target);

		let statProbeFoundFile = false;
		let attachedQualifier: string | null = null;
		let resolvedAbs: string | null = null;

		if (params.content !== false && !looksLikeRegex && classifyBareTarget(target) === "bare-plain") {
			const normalized = target.replace(/\/+$/, "");
			const rootDir = params.root ?? process.cwd();
			const absCandidate = path.isAbsolute(normalized) ? normalized : path.resolve(rootDir, normalized);

			try {
				const stat = await fs.stat(absCandidate);
				resolvedAbs = absCandidate;
				const inRoot = isInsideRoot(absCandidate, rootDir);

				if (stat.isFile()) {
					statProbeFoundFile = true;

					// BUG-348: out-of-root path. The kernel walker can't see it.
					if (!inRoot) {
						if (params.gitignore === false) {
							// Direct read short-circuit: caller explicitly opted in.
							const raw = await fs.readFile(absCandidate, "utf-8");
							return toolResult<GetToolResultDetails>({
								target: params.target,
								format: params.format,
							})
								.text(raw)
								.done();
						}
						const hint = `(hint: pass gitignore: false to read this file directly, or set root: "${path.dirname(absCandidate)}" to walk from there.)`;
						return toolResult<GetToolResultDetails>({
							target: params.target,
							error: "OUT_OF_PROJECT_ROOT",
						})
							.text(
								`OUT_OF_PROJECT_ROOT: ${params.target}\n  project root: ${rootDir}\n  resolved:     ${absCandidate}\n\n${hint}`,
							)
							.done();
					}

					// FEAT-713: always #raw for bare-path files. Drops the
					// outline-first default that returned [§file] markers
					// without content for source files (T1.1, T1.8 + repro).
					target = `${normalized}#raw`;
					attachedQualifier = "#raw (auto)";
				} else if (stat.isDirectory()) {
					target = buildDirQualifier(normalized, params);
					attachedQualifier = `${target.slice(normalized.length)} (auto)`;
				}
			} catch (err) {
				const code = (err as NodeJS.ErrnoException | undefined)?.code;
				const isExplicitPath =
					path.isAbsolute(normalized) || normalized.startsWith("./") || normalized.startsWith("../");
				if (isExplicitPath && code === "ENOENT") {
					return toolResult<GetToolResultDetails>({
						target: params.target,
						error: "PATH_NOT_FOUND",
					})
						.text(`PATH_NOT_FOUND: ${params.target} (resolved to ${absCandidate})`)
						.done();
				}
				if (isExplicitPath && (code === "EACCES" || code === "EPERM")) {
					return toolResult<GetToolResultDetails>({
						target: params.target,
						error: "PATH_NOT_READABLE",
					})
						.text(`PATH_NOT_READABLE: ${params.target} (resolved to ${absCandidate})`)
						.done();
				}
				// Other errors / non-explicit paths flow through to the kernel.
			}
		}

		const chunks = await executeCodePath({
			command: "get",
			target,

			format: params.format,
			root: params.root,
			gitignore: params.gitignore,
			abortSignal: signal,
		});

		const result = formatCodePathResult(chunks, {
			format: (params.format as CodePathFormatMode) ?? "node-list",
		});

		let displayText = result.text?.trim();

		if (!displayText) {
			// FEAT-714: structured diagnostic with reason + try-next hint.
			let reason = "empty-result";
			let tryNext: string | null = null;
			const evidence: string | null = null;

			if (statProbeFoundFile && classifyBareTarget(params.target) === "qualified") {
				reason = "qualifier-empty";
				tryNext = `target: "${params.target.split("#")[0]}#raw" or target: "${params.target.split("#")[0]}::§line[1..50]"`;
			} else if (statProbeFoundFile) {
				reason = "empty-content";
				tryNext = `target: "${params.target}::§line[1..50]"`;
			} else if (classifyBareTarget(params.target).startsWith("qualified") || params.target.includes("::")) {
				reason = "no-match";
				tryNext = `verify path/symbol exists, or try target: "${params.target.split(/[#:]/)[0]}"`;
			}

			displayText = buildNoResults({
				target: params.target,
				attachedQualifier,
				resolvedAbs,
				reason,
				evidence,
				tryNext,
			});
		}

		const text = prettifyDidYouMean(displayText);
		const builder = toolResult<GetToolResultDetails>({ format: params.format }).text(text);
		if (result.meta) {
			builder.limits({
				resultLimit: result.meta.limits?.resultLimit?.reached,
				headLimit: result.meta.limits?.headLimit?.reached,
			});
		}
		const toolRes = builder.done();

		// Include image content blocks if present
		if (result.images.length > 0) {
			const content = [...toolRes.content];
			for (const img of result.images) {
				content.push({ type: "image", data: img.data, mimeType: img.mimeType });
				if (img.text) {
					content.push({ type: "text", text: img.text });
				}
			}
			return { ...toolRes, content };
		}

		return toolRes;
	}

	/**
	 * Resolve targets whose authoritative state lives in JS via the session's
	 * internal URL router. Returns null when the router is unavailable or
	 * cannot handle the target, or when resolution fails (in which case the
	 * caller falls through to `executeCodePath`).
	 */
	private async tryResolveViaInternalRouter(
		target: string,
		params: GetParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult | null> {
		const router: InternalUrlRouter | undefined = this.session?.internalRouter;

		// Codepath syntax (`<uri>::<qualifier>`) is split off so the JS handler
		// only sees the URI base. The suffix is forwarded back to the kernel
		// against the resolved sourcePath when the resource is filesystem-backed,
		// or applied as a best-effort projection on plain content otherwise.
		const { uriBase, codepathSuffix } = splitCodepath(target);
		if (!router || !router.canHandle(uriBase)) return null;

		let resource: { url?: string; content: string; sourcePath?: string };
		try {
			resource = await router.resolve(uriBase);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return toolResult<GetToolResultDetails>({ format: params.format, target, error: message })
				.text(`[§error] ${target}\n  ${message}`)
				.error()
				.done();
		}

		// Filesystem-backed resource + codepath qualifier → kernel handles the
		// projection on the real path. Virtual sourcePaths ("pi://...", embedded
		// docs, in-memory state) skip this branch.
		const sourcePath = resource.sourcePath;
		if (codepathSuffix && sourcePath && !sourcePath.includes("://")) {
			const chunks = await executeCodePath({
				command: "get",
				target: sourcePath + codepathSuffix,
				format: params.format,

				gitignore: params.gitignore,
				abortSignal: signal,
			});
			const rendered = formatCodePathResult(chunks, {
				format: (params.format as CodePathFormatMode) ?? "node-list",
			});
			return toolResult<GetToolResultDetails>({ format: params.format, target })
				.text(rendered.text?.trim() || `[§empty] ${target}`)
				.sourceInternal(resource.url ?? target)
				.done();
		}

		let text: string = resource.content;
		if (codepathSuffix) {
			const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uriBase);
			const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "unknown";
			text = `${text || ""}\n[note] codepath qualifier '${codepathSuffix}' ignored (resource '${scheme}://' is not filesystem-backed)`;
		}
		return toolResult<GetToolResultDetails>({ format: params.format, target })
			.text(text || `[§empty] ${target}`)
			.sourceInternal(resource.url ?? target)
			.done();
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		const uiTheme = theme as Theme;
		const text = prettifyDidYouMean(
			result.content
				.filter(c => c.type === "text")
				.map(c => (c as { text?: string }).text ?? "")
				.join("\n"),
		);
		const sanitized = replaceTabs(text);
		const maxChars = 2_000;
		const truncated = sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}\n...truncated` : sanitized;
		return {
			render: (width: number) =>
				renderCodeCell(
					{
						code: truncated,
						language: "text",
						title: "Get",
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
