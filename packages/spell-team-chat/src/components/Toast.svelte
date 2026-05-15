<script lang="ts">
	import { toasts } from "../lib/stores.svelte";
</script>

<div class="toast-stack" role="status" aria-live="polite">
	{#each toasts.items as t (t.id)}
		<div class="toast {t.kind}">{t.message}</div>
	{/each}
</div>

<style>
	.toast-stack {
		position: fixed;
		top: 16px;
		right: 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		z-index: var(--z-toast);
		pointer-events: none;
	}
	.toast {
		padding: 10px 14px;
		border-radius: var(--radius-md);
		background: var(--bg-elevated);
		color: var(--text-primary);
		box-shadow: var(--shadow-lg);
		font-size: var(--font-size-sm);
		border-left: 3px solid var(--accent-primary);
		min-width: 240px;
		max-width: 420px;
		animation: slide-in 200ms ease-out;
	}
	.toast.success { border-left-color: var(--color-success); }
	.toast.error   { border-left-color: var(--color-error); }
	.toast.info    { border-left-color: var(--color-info); }
	@keyframes slide-in {
		from { opacity: 0; transform: translateX(16px); }
		to   { opacity: 1; transform: translateX(0); }
	}
</style>
