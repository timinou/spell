import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { InternalUrlRouter } from "../internal-urls";
import { RouterDelegateToKernel } from "../internal-urls/router";
import type { Theme } from "../modes/theme/theme";
import getDescription from "../prompts/tools/get.md" with { type: "text" };
import { renderCodeCell, renderStatusLine } from "../tui";
import { type CodePathFormatMode, formatCodePathResult } from "./codepath-result";
import { sessionContextOpts } from "./codepath-session";
import type { CodePathChunk, GetParams, NodeRefDto } from "./codepath-types";
import { getSchema } from "./codepath-types";
import type { ToolSession } from "./index";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";

type GetToolResultDetails = DetailsWithMeta & {
	format?: string;
	target?: string;
	error?: string;
	// FEAT-786: quantitative summary surfaced for the TUI meta line.
	nodeCount?: number;
	matchCount?: number;
	fileCount?: number;
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
 * PLAN-310: extract a single kernel-resolved §<scheme> node from a CodePath
 * result, if present. The kernel SchemeRegistry emits one such NodeRef per
 * successful URI resolution; the JS handler shape (notes prefix + content +
 * sourceInternal) is rebuilt by `renderSchemeNode` below.
 */
// §kinds emitted by fs/text/outline dialects — NOT URI-scheme nodes.
const NON_SCHEME_NODE_KINDS = new Set([
	"§file",
	"§dir",
	"§symlink",
	"§outline",
	"§line",
	"§match",
	"§stat",
	"§tree",
	"§empty",
	"§error",
	"§raw",
	"§listing",
]);

function extractSchemeNode(chunks: CodePathChunk[]): NodeRefDto | null {
	const nodes = chunks.flatMap(c => c.nodes);
	if (nodes.length !== 1) return null;
	const node = nodes[0];
	if (typeof node.kind !== "string" || !node.kind.startsWith("§") || node.kind.length < 2) return null;
	if (NON_SCHEME_NODE_KINDS.has(node.kind)) return null;
	return node;
}

function renderSchemeNode(node: NodeRefDto, params: GetParams, target: string): AgentToolResult {
	const content = node.content;
	const body =
		content?.kind === "text"
			? content.value
			: ((content as { text?: string; value?: string } | undefined)?.text ??
				(content as { value?: string } | undefined)?.value ??
				"");
	const meta = (node.metadata ?? {}) as Record<string, unknown>;
	const notes = Array.isArray(meta.notes) ? (meta.notes as string[]) : [];
	const notePrefix = notes.length ? `${notes.map(n => `[note] ${n}`).join("\n")}\n` : "";
	const text = `${notePrefix}${body || `[§empty] ${target}`}`;
	return toolResult<GetToolResultDetails>({ format: params.format, target })
		.text(text)
		.sourceInternal(node.locator)
		.done();
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
 * Extract the longest absolute directory prefix from a CodePath target.
 * Strips, in order: symbol query (`::...`), qualifier (`#...`), glob meta
 * (everything from first `*`, `?`, or `[`), and trailing `/`.
 * Returns the stripped string if absolute; otherwise `null`.
 */
function extractAbsolutePrefix(target: string): string | null {
	const stripped = target
		.replace(/::.*$/, "") // symbol query
		.replace(/#.*$/, "") // qualifier
		.replace(/[*?[].*$/, "") // glob meta
		.replace(/\/+$/, ""); // trailing slash
	return path.isAbsolute(stripped) ? stripped : null;
}

/**
 * Walk up from `absPath` until an existing directory is found.
 * Uses sync stat (cheap, bounded). Returns `/` as ultimate fallback.
 */
function nearestExistingDir(absPath: string): string {
	let dir = absPath;
	for (;;) {
		try {
			if (statSync(dir).isDirectory()) return dir;
		} catch {
			// ENOENT / EACCES — continue walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return dir; // reached filesystem root
		dir = parent;
	}
}

/**
 * Compute the effective walker root for a CodePath target.
 * - Explicit `providedRoot` wins unconditionally.
 * - For absolute targets, extract the directory prefix and find the
 *   nearest existing ancestor directory.
 * - Relative targets fall back to `sessionCwd`.
 */
function effectiveRootFor(target: string, providedRoot: string | undefined, sessionCwd: string): string {
	if (providedRoot) return providedRoot;
	const prefix = extractAbsolutePrefix(target);
	if (!prefix) return sessionCwd;
	return nearestExistingDir(prefix);
}

/**
 * Convert an absolute CodePath target to a relative path against `rootDir`.
 * Preserves qualifiers (`#...`, `::...`). When the target is already relative
 * or the conversion would escape `rootDir`, returns the original target.
 */
function makeRelativeToRoot(target: string, rootDir: string): string {
	if (!rootDir || !path.isAbsolute(target)) return target;

	// Find the first structural separator that splits the filesystem path from qualifiers.
	// The target can have `::` and `#` in any order; pick the earliest split point.
	const qi = target.indexOf("::");
	const hi = target.indexOf("#");
	let splitAt = -1;
	if (qi >= 0 && hi >= 0) {
		splitAt = Math.min(qi, hi);
	} else if (qi >= 0) {
		splitAt = qi;
	} else if (hi >= 0) {
		splitAt = hi;
	}

	const base = splitAt >= 0 ? target.slice(0, splitAt) : target;
	const suffix = splitAt >= 0 ? target.slice(splitAt) : "";

	const rel = path.relative(rootDir, base);
	// BUG-380: when target resolves to root itself, address the root via `.`
	// (kernel can't resolve `<root>` inside `<root>` — returns []).
	// `#listing` is the kernel's directory-listing op which rejects the
	// `.` prefix ("Not a directory"); bare `.` produces the equivalent
	// listing, so collapse it.
	if (rel === "") return suffix === "#listing" ? "." : `.${suffix}`;
	if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
		return rel + suffix;
	}
	return target;
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

/**
 * FEAT-787: shared CodePath render surface for find/get/create.
 *
 * The TUI previously showed only the bold tool label — the CodePath `target`
 * (the one piece of state describing what the call does) was invisible, and the
 * result cell used a hardcoded "Get" title that leaked onto `find`. These
 * helpers render the CodePath in both the pending (renderCall) and resolved
 * (renderResult) states, with a metadata line (format · counts · caps).
 */
export interface CodePathRenderDetails extends DetailsWithMeta {
	format?: string;
	target?: string;
	nodeCount?: number;
	matchCount?: number;
	fileCount?: number;
}

const CODEPATH_HEADER_MAX = 96;

function truncateQuery(query: string): string {
	const flat = query.replace(/\s+/g, " ").trim();
	return flat.length > CODEPATH_HEADER_MAX ? `${flat.slice(0, CODEPATH_HEADER_MAX - 1)}\u2026` : flat;
}

function pluralize(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

function codePathMetaParts(details: CodePathRenderDetails | undefined): string[] {
	if (!details) return [];
	const parts: string[] = [];
	if (details.format && details.format !== "node-list") parts.push(details.format);
	if (typeof details.fileCount === "number" && details.fileCount > 0) {
		parts.push(pluralize(details.fileCount, "file", "files"));
	}
	if (typeof details.matchCount === "number" && details.matchCount > 0) {
		parts.push(pluralize(details.matchCount, "match", "matches"));
	}
	const limits = details.meta?.limits;
	if (limits?.resultLimit) parts.push("\u29f7 result-capped");
	if (limits?.headLimit) parts.push("\u29f7 head-capped");
	return parts;
}

/** Pending-state status line: tool verb + the CodePath query. */
export function renderCodePathCall(
	verb: string,
	query: string | undefined,
	options: RenderResultOptions,
	theme: unknown,
): Component {
	const uiTheme = theme as Theme;
	const line = renderStatusLine(
		{
			icon: options.isPartial ? "pending" : "success",
			spinnerFrame: options.spinnerFrame,
			title: verb,
			description: query ? truncateQuery(query) : undefined,
		},
		uiTheme,
	);
	return { render: () => [line], invalidate: () => {} };
}

/** Resolved-state code cell: verb + CodePath in the header, counts in meta. */
export function renderCodePathCell(
	verb: string,
	result: AgentToolResult,
	options: RenderResultOptions,
	theme: unknown,
): Component {
	const uiTheme = theme as Theme;
	const details = result.details as CodePathRenderDetails | undefined;
	const text = prettifyDidYouMean(
		result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text?: string }).text ?? "")
			.join("\n"),
	);
	const sanitized = replaceTabs(text);
	const maxChars = 2_000;
	const truncated = sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}\n...truncated` : sanitized;
	const query = details?.target;
	const title = query ? `${verb}  ${truncateQuery(query)}` : verb;
	return {
		render: (width: number) =>
			renderCodeCell(
				{
					code: truncated,
					language: "text",
					title,
					metaParts: codePathMetaParts(details),
					status: result.isError ? "error" : "complete",
					expanded: options.expanded,
					width,
				},
				uiTheme,
			),
		invalidate: () => {},
	};
}

export class GetTool implements AgentTool<typeof getSchema> {
	readonly name = "get";
	readonly label = "Get";
	readonly description = getDescription;
	readonly parameters = getSchema;
	readonly lenientArgValidation = true;
	// FEAT-787: pending shows the CodePath via renderCall; result shows the cell
	// (mergeCallAndResult suppresses the call line once the result arrives).
	readonly mergeCallAndResult = true;

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

		const rootDir = effectiveRootFor(target, params.root, process.cwd());

		if (params.content !== false && !looksLikeRegex && classifyBareTarget(target) === "bare-plain") {
			const normalized = target.replace(/\/+$/, "");
			const absCandidate = path.isAbsolute(normalized) ? normalized : path.resolve(rootDir, normalized);

			try {
				const stat = await fs.stat(absCandidate);
				resolvedAbs = absCandidate;

				if (stat.isFile()) {
					statProbeFoundFile = true;

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

		// Normalize absolute targets to relative against the auto-computed root
		// so the kernel's subtree walker can resolve them. In-cwd paths
		// normally pass through unchanged (the kernel handles them directly),
		// but the root-equal case (BUG-380) must always convert: the kernel
		// can't resolve `<root>` inside `<root>` and returns []. `.` is the
		// portable address for the root itself.
		const absPrefix = extractAbsolutePrefix(target);
		if (!looksLikeRegex && absPrefix !== null) {
			const rootEqual = path.resolve(absPrefix) === path.resolve(rootDir);
			if (rootEqual || !absPrefix.startsWith(process.cwd())) {
				target = makeRelativeToRoot(target, rootDir);
			}
		}

		const chunks = await executeCodePath({
			...sessionContextOpts(this.session ?? null),
			command: "get",
			target,

			format: params.format,
			root: rootDir,
			gitignore: params.gitignore,
			abortSignal: signal,
		});

		// PLAN-310 cutover: kernel-resolved URI scheme nodes (kind="§<scheme>")
		// render with the legacy JS-handler shape: optional notes prefix +
		// content body + sourceInternal(url). This bypasses the buildNodeList
		// `[§kind]` label so the result is shape-equivalent to the JS path.
		const schemeNode = extractSchemeNode(chunks);
		if (schemeNode) {
			return renderSchemeNode(schemeNode, params, target);
		}

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
		const builder = toolResult<GetToolResultDetails>({
			format: params.format,
			target: params.target,
			nodeCount: result.stats.nodeCount,
			matchCount: result.stats.matchCount,
			fileCount: result.stats.fileCount,
		}).text(text);
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
				if (!img.skipImageBlock) {
					content.push({ type: "image", data: img.data, mimeType: img.mimeType });
				}
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

		let resource: { url?: string; content: string; sourcePath?: string; notes?: readonly string[] };
		try {
			resource = await router.resolve(uriBase);
		} catch (error) {
			// PLAN-310 cutover: the router throws RouterDelegateToKernel for schemes
			// in KERNEL_OWNED_SCHEMES. Falling through to executeCodePath lets the
			// kernel SchemeRegistry handle resolution.
			if (error instanceof RouterDelegateToKernel) return null;
			const message = error instanceof Error ? error.message : String(error);
			return toolResult<GetToolResultDetails>({ format: params.format, target, error: message })
				.text(`[§error] ${target}\n  ${message}`)
				.error()
				.done();
		}

		// Filesystem-backed resource + codepath qualifier → kernel handles the
		// projection on the real path. Virtual sourcePaths ("pi://...", embedded
		// docs, in-memory state) skip this branch.
		const notePrefix = resource.notes?.length ? `${resource.notes.map(n => `[note] ${n}`).join("\n")}\n` : "";
		const sourcePath = resource.sourcePath;
		if (codepathSuffix && sourcePath && !sourcePath.includes("://")) {
			// FEAT-726: kernel codepath qualifiers only work on relative targets;
			// convert absolute sourcePaths when they sit under the active root.
			let effectiveTarget = sourcePath + codepathSuffix;
			if (path.isAbsolute(sourcePath)) {
				const rel = path.relative(params.root ?? process.cwd(), sourcePath);
				if (!rel.startsWith("..")) {
					effectiveTarget = rel + codepathSuffix;
				}
			}
			const chunks = await executeCodePath({
				...sessionContextOpts(this.session ?? null),
				command: "get",
				target: effectiveTarget,
				format: params.format,

				gitignore: params.gitignore,
				abortSignal: signal,
			});
			const rendered = formatCodePathResult(chunks, {
				format: (params.format as CodePathFormatMode) ?? "node-list",
			});
			return toolResult<GetToolResultDetails>({
				format: params.format,
				target,
				nodeCount: rendered.stats.nodeCount,
				matchCount: rendered.stats.matchCount,
				fileCount: rendered.stats.fileCount,
			})
				.text(notePrefix + (rendered.text?.trim() || `[§empty] ${target}`))
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
			.text(notePrefix + (text || `[§empty] ${target}`))
			.sourceInternal(resource.url ?? target)
			.done();
	}

	renderCall(args: unknown, options: RenderResultOptions, theme: unknown): Component {
		const target = (args as GetParams | undefined)?.target;
		return renderCodePathCall(this.label, target, options, theme);
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		return renderCodePathCell(this.label, result, options, theme);
	}
}
