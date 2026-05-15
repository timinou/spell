<script lang="ts">
	import type { SessionState } from "../lib/stores.svelte";
	import { formatRelative } from "../lib/time";
	import Bubble from "./Bubble.svelte";
	import InputBar from "./InputBar.svelte";

	interface Props {
		sessionState: SessionState;
		token: string;
		onSubmit: (text: string) => void | Promise<void>;
		onAbort: () => void;
		onKill: () => void;
		onBlockingAction: (eventId: string, choice: string | number) => void;
	}
	let { sessionState, token, onSubmit, onAbort, onKill, onBlockingAction }: Props = $props();

	let scrollHost: HTMLDivElement | undefined = $state(undefined);
	let userScrolledUp = $state(false);

	const visibleBubbles = $derived(
		sessionState.pendingAssistant
			? [...sessionState.bubbles, sessionState.pendingAssistant]
			: sessionState.bubbles,
	);
	const isExternal = $derived(sessionState.summary.kind === "external");

	$effect(() => {
		void visibleBubbles.length;
		if (!scrollHost || userScrolledUp) return;
		queueMicrotask(() => {
			if (scrollHost) scrollHost.scrollTop = scrollHost.scrollHeight;
		});
	});

	function onScroll(e: Event) {
		const el = e.target as HTMLDivElement;
		const slack = 80;
		userScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > slack;
	}
</script>

<section class="pane">
	<header class="topbar">
		<div class="title">
			<h2>{sessionState.summary.projectName || sessionState.summary.cwd}</h2>
			<div class="meta">
				<span class="mono">{sessionState.summary.kind}</span>
				<span class="muted">·</span>
				<span class="muted mono small" title={sessionState.summary.cwd}>{sessionState.summary.cwd}</span>
				<span class="muted">·</span>
				<span class="muted">started {formatRelative(sessionState.summary.startedAt)}</span>
			</div>
		</div>
		<div class="actions">
			{#if !isExternal}
				<button class="btn" onclick={onKill}>Kill</button>
			{/if}
		</div>
	</header>

	<div class="log" bind:this={scrollHost} onscroll={onScroll}>
		{#each visibleBubbles as bubble (bubble.id)}
			<Bubble {bubble} {token} {onBlockingAction} />
		{/each}
		{#if visibleBubbles.length === 0}
			<div class="empty muted">
				{#if isExternal}
					Read-only stream from an external <span class="mono">spell</span> session. No history retained yet.
				{:else}
					Send a prompt to get started.
				{/if}
			</div>
		{/if}
	</div>

	{#if !isExternal}
		<InputBar
			busy={sessionState.busy}
			disabled={false}
			placeholder="Send a prompt…"
			{onSubmit}
			{onAbort}
		/>
	{:else}
		<div class="external-footer muted">
			<span>External session — prompt injection not yet supported.</span>
		</div>
	{/if}
</section>

<style>
	.pane { display: grid; grid-template-rows: auto 1fr auto; min-height: 0; background: var(--bg-primary); }
	.topbar {
		display: flex; align-items: center; justify-content: space-between;
		padding: 10px 16px;
		border-bottom: 1px solid var(--border-secondary);
		background: var(--bg-secondary);
	}
	.title h2 { margin: 0; font-size: var(--font-size-md); font-weight: var(--font-weight-semibold); }
	.meta { display: flex; gap: 6px; align-items: baseline; font-size: var(--font-size-xs); margin-top: 2px; }
	.small { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.log {
		overflow-y: auto;
		display: flex; flex-direction: column;
		gap: 8px;
		padding: 16px;
		min-height: 0;
	}
	.empty { display: grid; place-items: center; text-align: center; padding: var(--spacing-2xl); }
	.external-footer {
		padding: 10px 16px;
		font-size: var(--font-size-xs);
		border-top: 1px solid var(--border-secondary);
		background: var(--bg-secondary);
	}
</style>
