import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import getDescription from "../prompts/tools/get.md" with { type: "text" };
import { renderCodeCell } from "../tui";
import { type CodePathFormatMode, formatCodePathResult } from "./codepath-result";
import type { GetParams } from "./codepath-types";
import { getSchema } from "./codepath-types";
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
 * BUG-347: slice a text body by line range using head/tail/offset/limit.
 * Pagination params on a single text-content node operated at *node count*
 * before this fix, which made `head: N` a silent no-op for `#raw` results.
 * This helper applies them at *line count* so the surface contract matches
 * what agents migrating from `cat | head -N` expect.
 *
 * Semantics:
 * - `offset`: 0-indexed line offset to start from.
 * - `head`/`limit`: keep the first N lines (after offset). `head: 0` keeps
 *   zero lines (param is honoured, not ignored).
 * - `tail`: keep the last N lines. Wins over head/limit when both set.
 */
function applyTextSlice(
	text: string,
	params: Pick<GetParams, "head" | "tail" | "offset" | "limit">,
): { text: string; sliced: boolean; total: number; from?: number; to?: number } {
	const lines = text.split("\n");
	// Trailing newline produces a final empty element; preserve it.
	const hasTrailingNewline = text.endsWith("\n");
	const contentLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
	const total = contentLines.length;

	let sliced = false;
	let start = 0;
	let end = total;

	if (params.offset !== undefined) {
		start = Math.max(0, Math.min(params.offset, total));
		sliced = true;
	}

	if (params.tail !== undefined) {
		const n = Math.max(0, Math.min(params.tail, total - start));
		start = total - n;
		end = total;
		sliced = true;
	} else {
		const headOrLimit = params.head ?? params.limit;
		if (headOrLimit !== undefined) {
			end = Math.min(total, start + Math.max(0, headOrLimit));
			sliced = true;
		}
	}

	if (!sliced) return { text, sliced: false, total };

	const slice = contentLines.slice(start, end);
	const out = slice.join("\n") + (slice.length > 0 && hasTrailingNewline ? "\n" : "");
	return { text: out, sliced: true, total, from: start + 1, to: end };
}

/**
 * Detect whether GetParams asks for line-level pagination of text content.
 */
function wantsTextSlice(params: GetParams): boolean {
	return (
		params.head !== undefined ||
		params.tail !== undefined ||
		params.offset !== undefined ||
		params.limit !== undefined
	);
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

export class GetTool implements AgentTool<typeof getSchema> {
	readonly name = "get";
	readonly label = "Get";
	readonly description = getDescription;
	readonly parameters = getSchema;
	readonly lenientArgValidation = true;

	async execute(
		_toolCallId: string,
		params: GetParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		let target = params.target;
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
							const slice = applyTextSlice(raw, params);
							return toolResult<GetToolResultDetails>({
								target: params.target,
								format: params.format,
							})
								.text(slice.text)
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
			limit: params.limit,
			head: params.head,
			tail: params.tail,
			offset: params.offset,
			format: params.format,
			root: params.root,
			gitignore: params.gitignore,
			abortSignal: signal,
		});

		const result = formatCodePathResult(chunks, {
			format: (params.format as CodePathFormatMode) ?? "node-list",
			limit: params.limit,
		});

		let displayText = result.text?.trim();

		// BUG-347: post-slice single-node text bodies when pagination params
		// are set. The kernel applies head/tail/offset/limit at node count;
		// for #raw results that's a single node, so the params would no-op.
		// Slicing here makes them honour line semantics, matching cat|head.
		if (wantsTextSlice(params) && displayText) {
			const allNodes = chunks.flatMap(c => c.nodes);
			const textNodes = allNodes.filter(
				n => n.content && (n.content as { text?: string; value?: string }).text !== undefined,
			);
			if (textNodes.length === 1 && allNodes.length === 1) {
				const rawText =
					(textNodes[0].content as { text?: string; value?: string }).text ??
					(textNodes[0].content as { value?: string }).value ??
					"";
				const slice = applyTextSlice(rawText, params);
				if (slice.sliced) displayText = slice.text;
			}
		}

		if (!displayText) {
			// FEAT-714: structured diagnostic with reason + try-next hint.
			let reason = "empty-result";
			let tryNext: string | null = null;
			const evidence: string | null = null;

			if (statProbeFoundFile && wantsTextSlice(params) && attachedQualifier === "#raw (auto)") {
				reason = "pagination-overshoot";
				tryNext = `reduce offset/head, or use target: "${params.target}::§line[a..b]"`;
			} else if (statProbeFoundFile && classifyBareTarget(params.target) === "qualified") {
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
