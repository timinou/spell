<script lang="ts">
	interface Props {
		busy: boolean;
		disabled: boolean;
		placeholder?: string;
		onSubmit: (text: string) => void | Promise<void>;
		onAbort?: () => void;
	}
	let { busy, disabled, placeholder = "Send a message…", onSubmit, onAbort }: Props = $props();

	let draft = $state("");
	let textarea: HTMLTextAreaElement | undefined = $state(undefined);

	async function send() {
		const text = draft.trim();
		if (!text) return;
		draft = "";
		await onSubmit(text);
	}

	function onKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			void send();
		}
	}
</script>

<div class="bar">
	<textarea
		bind:this={textarea}
		bind:value={draft}
		onkeydown={onKey}
		rows={2}
		{placeholder}
		{disabled}
		aria-label="Message"
	></textarea>
	<div class="row">
		<span class="muted hint">⌘⏎ to send</span>
		<span class="spacer"></span>
		{#if busy && onAbort}
			<button class="btn" onclick={onAbort}>Abort</button>
		{/if}
		<button
			class="btn btn-primary"
			onclick={send}
			disabled={disabled || draft.trim().length === 0}
		>{busy ? "Sending…" : "Send"}</button>
	</div>
</div>

<style>
	.bar {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 16px;
		border-top: 1px solid var(--border-secondary);
		background: var(--bg-primary);
	}
	textarea { min-height: 60px; max-height: 240px; }
	.row { display: flex; align-items: center; gap: 8px; }
	.spacer { flex: 1; }
	.hint { font-size: var(--font-size-xs); }
</style>
