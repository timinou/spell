<script lang="ts">
	import type { ArtifactCreatedEvent } from "../lib/protocol";
	import { api } from "../lib/api";

	interface Props {
		artifact: ArtifactCreatedEvent;
		token: string;
	}
	let { artifact, token }: Props = $props();

	let signedUrl = $state<string | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	const isImage = $derived(/^image\//.test(artifact.mime));
	const isText = $derived(/^text\//.test(artifact.mime) || /^application\/(json|javascript)/.test(artifact.mime));
	const artifactPath = $derived(`${artifact.agent}/${artifact.tool}/${artifact.filename}`);

	async function loadUrl() {
		if (signedUrl || loading) return;
		loading = true;
		try {
			const r = await api.mintArtifactUrl(token, artifact.sessionId, artifactPath, 300);
			signedUrl = r.url;
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void loadUrl();
	});
</script>

<div class="artifact">
	<div class="meta">
		<span class="mono">{artifact.tool}</span>
		<span class="muted">·</span>
		<span class="filename">{artifact.filename}</span>
		<span class="muted">·</span>
		<span class="muted">{formatBytes(artifact.sizeBytes)}</span>
	</div>
	{#if error}
		<div class="err">{error}</div>
	{:else if signedUrl && isImage}
		<a href={signedUrl} target="_blank" rel="noreferrer">
			<img src={signedUrl} alt={artifact.filename} />
		</a>
	{:else if signedUrl && isText}
		<a href={signedUrl} class="open-link" target="_blank" rel="noreferrer">Open ↗</a>
	{:else if signedUrl}
		<a href={signedUrl} class="open-link" target="_blank" rel="noreferrer" download>Download ↓</a>
	{:else}
		<div class="muted small">loading preview…</div>
	{/if}
</div>

<script module lang="ts">
	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<style>
	.artifact {
		border: 1px solid var(--border-secondary);
		border-radius: var(--radius-md);
		padding: 10px;
		background: var(--bg-elevated);
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: 480px;
	}
	.meta { font-size: var(--font-size-xs); display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
	.filename { font-family: var(--font-mono); color: var(--text-secondary); }
	img { width: 100%; height: auto; border-radius: var(--radius-sm); display: block; }
	.open-link { font-size: var(--font-size-sm); color: var(--accent-primary); }
	.err { color: var(--color-error); font-size: var(--font-size-xs); }
	.small { font-size: var(--font-size-xs); }
</style>
