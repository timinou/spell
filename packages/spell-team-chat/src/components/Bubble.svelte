<script lang="ts">
	import type { ChatBubble } from "../lib/stores.svelte";
	import { formatClock } from "../lib/time";
	import { classifyDiffLines, summariseArgs } from "../lib/bubble-presentation";
	import ArtifactInline from "./ArtifactInline.svelte";

	interface Props {
		bubble: ChatBubble;
		token: string;
		onBlockingAction?: (eventId: string, choice: string | number) => void;
	}
	let { bubble, token, onBlockingAction }: Props = $props();

	// PLAN-338: classify edit tool_end results so undo/redo/declined read clearly.
	// The kernel renders the result text with recognisable lead lines:
	//   "undo · <file>", "redo · <file>", or "undo declined: already committed — …".
	const editClass = $derived.by<"declined" | "undo" | "redo" | null>(() => {
		if (bubble.kind !== "tool_end" || bubble.toolName !== "edit") return null;
		const t = (bubble.text ?? "").trimStart();
		if (/^undo declined/i.test(t) || /declined: already committed/i.test(t)) return "declined";
		if (/^undo[\s·]/.test(t)) return "undo";
		if (/^redo[\s·]/.test(t)) return "redo";
		return null;
	});

	// A tool_start carries `args` but no `text`, so it used to render as "(empty)".
	// Summarise the salient target (path/target/command/query/…) into a compact
	// mono line, mirroring the structured-tile language of the side panels.
	const toolSummary = $derived.by<string | null>(() =>
		bubble.kind === "tool_start" || bubble.kind === "tool_update" ? summariseArgs(bubble.args) : null,
	);

	// Split a tool result body into typed lines so unified diffs render with
	// add/remove/hunk accents instead of a flat grey slab.
	const bodyLines = $derived.by(() =>
		bubble.kind === "tool_end" && bubble.text ? classifyDiffLines(bubble.text) : null,
	);
</script>

<div class="bubble {bubble.kind}" class:err={bubble.isError} class:edit-declined={editClass === "declined"} class:edit-undo={editClass === "undo" || editClass === "redo"}>
	<div class="meta">
		<span class="speaker">{labelFor(bubble.kind)}</span>
		{#if bubble.toolName}
			<span class="muted mono">{bubble.toolName}</span>
		{/if}
		{#if editClass === "declined"}
			<span class="edit-tag declined" title="Undo declined — file is committed">declined</span>
		{:else if editClass === "undo"}
			<span class="edit-tag undo">undo</span>
		{:else if editClass === "redo"}
			<span class="edit-tag undo">redo</span>
		{/if}
		<span class="muted clock">{formatClock(bubble.ts)}</span>
	</div>
	<div class="body">
		{#if bubble.kind === "blocking" && bubble.blocking}
			{#if bubble.blocking.kind === "plan_approval"}
				<div class="block-title">{bubble.blocking.title}</div>
				<div class="block-summary mono">{bubble.blocking.planSummary}</div>
				<div class="block-actions">
					{#each bubble.blocking.selectorOptions as opt, i}
						<button class="btn" onclick={() => onBlockingAction?.(bubble.blocking!.eventId, i)}>{opt}</button>
					{/each}
				</div>
			{:else if bubble.blocking.kind === "ask"}
				<div class="block-title">Question</div>
				{#each bubble.blocking.questions as q}
					<div class="block-summary">{q.question}</div>
					<div class="block-actions">
						{#each q.options as opt, i}
							<button class="btn" onclick={() => onBlockingAction?.(bubble.blocking!.eventId, i)}>{opt.label}</button>
						{/each}
					</div>
				{/each}
			{:else if bubble.blocking.kind === "hook_selector"}
				<div class="block-title">{bubble.blocking.title}</div>
				<div class="block-actions">
					{#each bubble.blocking.options as opt, i}
						<button class="btn" onclick={() => onBlockingAction?.(bubble.blocking!.eventId, i)}>{opt}</button>
					{/each}
				</div>
			{:else}
				<div class="block-title">{(bubble.blocking as { title?: string; actionType?: string }).title ?? (bubble.blocking as { actionType?: string }).actionType}</div>
				<div class="block-summary muted">awaiting response…</div>
			{/if}
		{:else if bubble.kind === "ask" && bubble.ask}
			<div class="block-title">{bubble.ask.fromTaskId ?? "worker"} asks</div>
			<div class="block-summary">{bubble.ask.question}</div>
			{#if bubble.ask.status === "answered"}
				<div class="ask-answer">orchestrator answered</div>
				<pre class="text">{bubble.ask.answer}</pre>
			{:else if bubble.ask.status === "cancelled"}
				<div class="block-summary muted">cancelled—{bubble.ask.reason}</div>
			{:else}
				<div class="block-summary muted">awaiting orchestrator…</div>
			{/if}
		{:else if bubble.kind === "artifact" && bubble.artifact}
			<ArtifactInline artifact={bubble.artifact} {token} />
		{:else if toolSummary}
			<code class="tool-summary">{toolSummary}</code>
		{:else if bodyLines}
			<pre class="text diff">{#each bodyLines as ln}<span class="dl {ln.cls}">{ln.text}
</span>{/each}</pre>
		{:else if bubble.text}
			<pre class="text">{bubble.text}</pre>
		{:else if bubble.kind === "tool_start"}
			<span class="muted small">running…</span>
		{:else}
			<span class="muted">(empty)</span>
		{/if}
	</div>
</div>

<script module lang="ts">
	function labelFor(kind: string): string {
		switch (kind) {
			case "user": return "You";
			case "assistant": return "Spell";
			case "assistant_thinking": return "Spell (thinking)";
			case "tool_start": return "tool →";
			case "tool_end": return "tool ←";
			case "tool_update": return "tool ↻";
			case "blocking": return "Blocking";
			case "ask": return "Dialogue";
			case "external_log": return "External";
			case "artifact": return "Artifact";
			case "system": return "System";
			case "error": return "Error";
			default: return kind;
		}
	}
</script>

<style>
	.bubble {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-width: 760px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		background: var(--bg-elevated);
		box-shadow: var(--shadow-sm);
	}
	.bubble.user {
		align-self: flex-end;
		background: var(--accent-faint);
		border-color: var(--border-secondary);
	}
	.bubble.assistant { border-color: var(--border-secondary); }
	.bubble.assistant_thinking {
		opacity: 0.85;
		border-style: dashed;
		border-color: var(--border-primary);
		background: var(--bg-secondary);
	}
	.bubble.tool_start, .bubble.tool_update, .bubble.tool_end {
		background: var(--bg-secondary);
		border-color: var(--border-secondary);
		font-size: var(--font-size-xs);
	}
	/* PLAN-338: undo/redo and declined edit results get an intent accent. */
	.bubble.edit-undo {
		border-left: 3px solid var(--border-accent);
	}
	.bubble.edit-declined {
		border-left: 3px solid var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 8%, var(--bg-secondary));
	}
	.edit-tag {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		font-weight: var(--font-weight-semibold);
	}
	.edit-tag.undo { background: color-mix(in srgb, var(--border-accent) 18%, transparent); color: var(--border-accent); }
	.edit-tag.declined { background: color-mix(in srgb, var(--color-warning) 20%, transparent); color: var(--color-warning); }
	.bubble.blocking {
		border-left: 3px solid var(--color-warning);
		background: var(--bg-elevated);
	}
	.bubble.artifact {
		background: var(--bg-secondary);
		border-color: var(--border-secondary);
	}
	.bubble.ask {
		border-left: 3px solid var(--accent-faint, var(--border-secondary));
		background: var(--bg-secondary);
	}
	.ask-answer {
		font-size: var(--font-size-xs);
		color: var(--text-secondary);
		margin-top: 4px;
	}
	.bubble.external_log {
		background: var(--bg-secondary);
		font-size: var(--font-size-xs);
		opacity: 0.95;
	}
	.bubble.error { border-color: var(--color-error); color: var(--color-error); }
	.bubble.err { border-color: var(--color-error); }
	.meta {
		display: flex;
		gap: 8px;
		align-items: baseline;
		font-size: var(--font-size-xs);
	}
	.speaker { font-weight: var(--font-weight-medium); color: var(--text-secondary); }
	.clock { margin-left: auto; }
	.body { font-size: var(--font-size-sm); }
	.text {
		margin: 0;
		font-family: inherit;
		white-space: pre-wrap;
		word-wrap: break-word;
		line-height: var(--line-height-normal);
	}
	.block-title {
		font-weight: var(--font-weight-semibold);
		margin-bottom: 4px;
	}
	.block-summary {
		white-space: pre-wrap;
		font-size: var(--font-size-xs);
		color: var(--text-secondary);
		margin-bottom: 8px;
		max-height: 180px;
		overflow: auto;
	}
	.block-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	/* tool_start target summary — a compact mono chip instead of "(empty)". */
	.tool-summary {
		display: inline-block;
		max-width: 100%;
		padding: 2px 7px;
		border-radius: var(--radius-sm);
		background: var(--bg-tertiary);
		border: 1px solid var(--border-secondary);
		font-family: var(--font-mono, monospace);
		font-size: var(--font-size-xs);
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Unified-diff bodies get per-line add/remove/hunk accents. */
	.text.diff { display: block; }
	.dl { display: block; }
	.dl.add { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 12%, transparent); }
	.dl.del { color: var(--color-error); background: color-mix(in srgb, var(--color-error) 12%, transparent); }
	.dl.hunk { color: var(--accent-secondary); opacity: 0.85; }
	.dl.ctx { color: var(--text-secondary); }
</style>
