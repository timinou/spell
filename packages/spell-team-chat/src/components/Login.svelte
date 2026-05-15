<script lang="ts">
	import { tokenStore } from "../lib/api";

	interface Props {
		onLogin: (token: string) => void;
	}
	let { onLogin }: Props = $props();

	let token = $state("");
	let remember = $state(true);
	let error = $state<string | null>(null);

	function submit(event: Event) {
		event.preventDefault();
		if (!token.trim()) {
			error = "Token required";
			return;
		}
		if (remember) tokenStore.set(token.trim());
		onLogin(token.trim());
	}
</script>

<div class="login-wrap">
	<form class="login-card" onsubmit={submit}>
		<header>
			<h1>Spell Team Chat</h1>
			<p class="muted">Sign in with the bearer token from <span class="mono">~/.spell/server/web.tokens</span>.</p>
		</header>
		<label class="field">
			<span>Token</span>
			<input
				type="password"
				autocomplete="off"
				bind:value={token}
				placeholder="e.g. local-dev-token"
			/>
		</label>
		<label class="remember">
			<input type="checkbox" bind:checked={remember} />
			<span>Remember on this device</span>
		</label>
		{#if error}
			<div class="err">{error}</div>
		{/if}
		<button type="submit" class="btn btn-primary">Connect</button>
	</form>
</div>

<style>
	.login-wrap {
		display: grid;
		place-items: center;
		min-height: 100vh;
		background: var(--bg-secondary);
		padding: var(--spacing-md);
	}
	.login-card {
		width: 100%;
		max-width: 380px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-primary);
		border-radius: var(--radius-lg);
		padding: var(--spacing-xl);
		box-shadow: var(--shadow-lg);
		display: flex;
		flex-direction: column;
		gap: var(--spacing-md);
	}
	header h1 { margin: 0 0 4px; font-size: var(--font-size-xl); }
	header p { margin: 0; font-size: var(--font-size-sm); }
	.field { display: flex; flex-direction: column; gap: 6px; }
	.field span { font-size: var(--font-size-sm); color: var(--text-secondary); }
	.remember { display: flex; align-items: center; gap: 8px; font-size: var(--font-size-sm); color: var(--text-secondary); }
	.err { color: var(--color-error); font-size: var(--font-size-sm); }
</style>
