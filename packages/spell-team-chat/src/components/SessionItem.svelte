<script lang="ts">
	import type { SessionSummary } from "../lib/protocol";
	import { formatRelative } from "../lib/time";

	interface Props {
		session: SessionSummary;
		selected: boolean;
		onSelect: () => void;
	}
	let { session, selected, onSelect }: Props = $props();

	let cwdLabel = $derived(displayCwd(session.cwd, session.projectName));

	function displayCwd(cwd: string, projectName: string): string {
		if (projectName && projectName !== "unknown") return projectName;
		const parts = cwd.split("/");
		return parts[parts.length - 1] || cwd;
	}
</script>

<button
	type="button"
	class="item"
	class:selected
	class:active={selected}
	class:has-blocking={session.currentBlockingEvent !== undefined}
	onclick={onSelect}
	title={session.cwd}
>
	<span class="kind-dot" style="background: var(--color-kind-{session.kind})"></span>
	<span class="body">
		<span class="title">{cwdLabel}</span>
		<span class="sub">
			<span class="mono kind">{session.kind}</span>
			<span class="muted">·</span>
			<span class="muted">{formatRelative(session.startedAt)}</span>
			{#if session.currentBlockingEvent}
				<span class="muted">·</span>
				<span class="blocking-tag">{session.currentBlockingEvent.kind}</span>
			{/if}
		</span>
	</span>
</button>

<style>
	.item {
		display: flex;
		align-items: center;
		gap: var(--spacing-sm);
		width: 100%;
		padding: 8px var(--spacing-sm);
		padding-left: 12px;
		border: none;
		border-left: 2px solid transparent;
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		background: transparent;
		color: var(--text-primary);
		font-size: var(--font-size-sm);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--transition-fast), border-color var(--transition-fast);
		min-height: 44px;
	}
	.item:hover { background: var(--bg-tertiary); }
	.item.active { border-left-color: var(--accent-primary); background: var(--bg-tertiary); }
	.item.has-blocking { border-left-color: var(--color-warning); }
	.kind-dot {
		width: 8px; height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.body { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 2px; }
	.title { font-weight: var(--font-weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sub { display: flex; gap: 4px; align-items: center; font-size: var(--font-size-xs); }
	.kind { color: var(--text-tertiary); }
	.blocking-tag {
		color: var(--color-warning);
		font-weight: var(--font-weight-medium);
		font-size: var(--font-size-xs);
	}
</style>
