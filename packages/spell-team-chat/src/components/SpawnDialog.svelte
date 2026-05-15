<script lang="ts">
	import { onMount } from "svelte";
	import type { ManifestTemplate } from "../lib/api";

	interface Props {
		templates: ManifestTemplate[];
		onCancel: () => void;
		onSubmit: (input: { cwd: string; initialPrompt: string; templateName?: string }) => void | Promise<void>;
	}
	let { templates, onCancel, onSubmit }: Props = $props();

	let cwd = $state("");
	let prompt = $state("");
	let templateName = $state<string>("");
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let cwdInput: HTMLInputElement | undefined = $state(undefined);

	onMount(() => {
		cwdInput?.focus();
	});

	async function submit(event: Event) {
		event.preventDefault();
		if (!cwd.trim()) {
			error = "cwd required";
			return;
		}
		submitting = true;
		error = null;
		try {
			await onSubmit({
				cwd: cwd.trim(),
				initialPrompt: prompt.trim(),
				templateName: templateName ? templateName : undefined,
			});
		} catch (e) {
			error = String(e);
			submitting = false;
		}
	}

	function onBackdrop(e: MouseEvent) {
		if (e.target === e.currentTarget) onCancel();
	}
</script>

<div
	class="backdrop"
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	onclick={onBackdrop}
	onkeydown={(e) => { if (e.key === "Escape") onCancel(); }}
>
	<form class="dialog" onsubmit={submit}>
		<header>
			<h2>Spawn session</h2>
			<button type="button" class="btn btn-ghost" onclick={onCancel}>✕</button>
		</header>
		<label class="field">
			<span>Working directory <span class="muted">(absolute path)</span></span>
			<input
				type="text"
				bind:this={cwdInput}
				bind:value={cwd}
				placeholder="/home/user/code/my-project"
				autocomplete="off"
			/>
		</label>
		<label class="field">
			<span>Initial prompt <span class="muted">(optional)</span></span>
			<textarea bind:value={prompt} rows="3" placeholder="What should the agent do first?"></textarea>
		</label>
		{#if templates.length > 0}
			<label class="field">
				<span>Template <span class="muted">(optional)</span></span>
				<select bind:value={templateName}>
					<option value="">(none — raw chat session)</option>
					{#each templates as t}
						<option value={t.name}>{t.name}{t.description ? " — " + t.description : ""}</option>
					{/each}
				</select>
			</label>
		{/if}
		{#if error}<div class="err">{error}</div>{/if}
		<div class="actions">
			<button type="button" class="btn" onclick={onCancel} disabled={submitting}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={submitting}>
				{submitting ? "Spawning…" : "Spawn"}
			</button>
		</div>
	</form>
</div>

<style>
	.backdrop {
		position: fixed; inset: 0;
		background: var(--bg-overlay);
		display: grid; place-items: center;
		z-index: var(--z-modal);
		padding: var(--spacing-md);
	}
	.dialog {
		background: var(--bg-elevated);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border-primary);
		box-shadow: var(--shadow-xl);
		padding: var(--spacing-xl);
		width: 100%; max-width: 520px;
		display: flex; flex-direction: column; gap: var(--spacing-md);
	}
	header { display: flex; align-items: center; justify-content: space-between; }
	header h2 { margin: 0; font-size: var(--font-size-lg); }
	.field { display: flex; flex-direction: column; gap: 6px; font-size: var(--font-size-sm); }
	.field span { color: var(--text-secondary); }
	select {
		padding: 8px 10px;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-primary);
		background: var(--bg-elevated);
		color: var(--text-primary);
	}
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
	.err { color: var(--color-error); font-size: var(--font-size-sm); }
</style>
