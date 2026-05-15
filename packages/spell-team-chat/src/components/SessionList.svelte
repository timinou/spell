<script lang="ts">
	import { app } from "../lib/stores.svelte";
	import SessionItem from "./SessionItem.svelte";

	interface Props { onSpawn: () => void }
	let { onSpawn }: Props = $props();
</script>

<div class="rail">
	<header>
		<div class="brand">
			<span class="logo">✦</span>
			<span class="name">Spell</span>
		</div>
		<button class="btn btn-ghost" onclick={onSpawn} title="Spawn new session (Cmd+N)">+ New</button>
	</header>
	<div class="status">
		<span class="dot" class:ok={app.wsStatus === "auth_ok"}></span>
		<span class="muted mono">
			{#if app.wsStatus === "auth_ok"}connected{:else if app.wsStatus === "open"}authing…{:else if app.wsStatus === "connecting"}connecting…{:else}offline{/if}
		</span>
	</div>
	<div class="list">
		{#each app.orderedSessions as state (state.summary.sessionId)}
			<SessionItem
				session={state.summary}
				selected={app.selected === state.summary.sessionId}
				onSelect={() => app.select(state.summary.sessionId)}
			/>
		{/each}
		{#if app.orderedSessions.length === 0}
			<div class="empty">
				<p class="muted">No sessions yet.</p>
				<p class="muted"><span class="kbd">⌘N</span> to spawn one.</p>
			</div>
		{/if}
	</div>
</div>

<style>
	.rail {
		display: grid;
		grid-template-rows: auto auto 1fr;
		height: 100%;
		min-height: 0;
		background: var(--bg-secondary);
		border-right: 1px solid var(--border-secondary);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px;
		border-bottom: 1px solid var(--border-secondary);
	}
	.brand { display: flex; align-items: center; gap: 8px; }
	.logo { color: var(--accent-primary); font-size: 18px; }
	.name { font-weight: var(--font-weight-semibold); }
	.status {
		display: flex; align-items: center; gap: 8px;
		padding: 6px 12px;
		font-size: var(--font-size-xs);
		border-bottom: 1px solid var(--border-secondary);
	}
	.dot {
		width: 8px; height: 8px;
		border-radius: 50%;
		background: var(--color-error);
	}
	.dot.ok { background: var(--color-success); }
	.list {
		overflow-y: auto;
		padding: 8px 4px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.empty {
		padding: var(--spacing-lg) var(--spacing-md);
		text-align: center;
	}
</style>
