<script lang="ts">
	import type { SessionStateCore } from "../lib/reducers";

	interface Props {
		sessionState: SessionStateCore;
		onClose: () => void;
	}
	let { sessionState, onClose }: Props = $props();

	let selectedTab = $state<"process" | "stderr">("process");
	let stderrRef: HTMLPreElement | null = $state(null);

	$effect(() => {
		if (selectedTab === "stderr" && stderrRef) {
			stderrRef.scrollTop = stderrRef.scrollHeight;
		}
	});
</script>

<div class="panel">
	<div class="header">
		<div class="tabs">
			<button class="tab" class:active={selectedTab === "process"} onclick={() => (selectedTab = "process")}>
				Process
			</button>
			<button class="tab" class:active={selectedTab === "stderr"} onclick={() => (selectedTab = "stderr")}>
				Stderr
			</button>
		</div>
		<button class="close" onclick={onClose} aria-label="Close debug panel">✕</button>
	</div>

	<div class="body">
		{#if selectedTab === "process"}
			{#if sessionState.latestProcessInfo}
				<dl class="kv">
					<dt>pid</dt>
					<dd>{sessionState.latestProcessInfo.pid}</dd>
					<dt>rss</dt>
					<dd>{(sessionState.latestProcessInfo.rssBytes / 1024 / 1024).toFixed(1)} MB</dd>
					<dt>cpu</dt>
					<dd>{sessionState.latestProcessInfo.cpuPercent.toFixed(1)}%</dd>
					<dt>uptime</dt>
					<dd>{sessionState.latestProcessInfo.uptimeMs} ms</dd>
				</dl>
			{:else}
				<p class="muted">No data yet.</p>
			{/if}
		{:else}
			<pre bind:this={stderrRef} class="stderr">{#each sessionState.stderrLog as entry}{entry.ts}: {entry.line}
{/each}</pre>
		{/if}
	</div>
</div>

<style>
	.panel {
		position: fixed;
		top: 0;
		right: 0;
		width: 360px;
		height: 100vh;
		background: var(--bg-elevated);
		border-left: 1px solid var(--border-secondary);
		transform: translateX(0);
		transition: transform 200ms ease;
		z-index: 50;
		display: grid;
		grid-template-rows: auto 1fr;
	}
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border-secondary);
	}
	.tabs {
		display: flex;
		gap: 4px;
	}
	.tab {
		padding: 4px 10px;
		font-size: var(--font-size-xs);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
		color: var(--text-secondary);
	}
	.tab.active {
		border-color: var(--border-secondary);
		color: var(--text-primary);
		background: var(--bg-secondary);
	}
	.close {
		background: transparent;
		border: none;
		cursor: pointer;
		font-size: var(--font-size-sm);
		color: var(--text-secondary);
	}
	.body {
		padding: 12px;
		overflow: auto;
		min-height: 0;
	}
	.kv {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 6px 16px;
		font-size: var(--font-size-xs);
	}
	.kv dt {
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.kv dd {
		margin: 0;
		font-family: var(--font-mono);
	}
	.muted {
		color: var(--text-secondary);
		font-size: var(--font-size-xs);
	}
	.stderr {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		white-space: pre-wrap;
		word-break: break-word;
		overflow: auto;
		height: 100%;
	}
</style>
