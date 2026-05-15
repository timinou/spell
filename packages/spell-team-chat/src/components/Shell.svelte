<script lang="ts">
	import { app } from "../lib/stores.svelte";
	import type { ManifestTemplate } from "../lib/api";
	import SessionList from "./SessionList.svelte";
	import ChatPane from "./ChatPane.svelte";
	import SpawnDialog from "./SpawnDialog.svelte";
	import DebugPanel from "./DebugPanel.svelte";

	interface Props {
		debugOpen: boolean;
		onToggleDebug: (open: boolean) => void;
		token: string;
		templates: ManifestTemplate[];
		onSpawn: (input: { cwd: string; initialPrompt: string; templateName?: string }) => Promise<void>;
		onSubmit: (sessionId: string, text: string) => Promise<void>;
		onAbort: (sessionId: string) => void;
		onKill: (sessionId: string) => Promise<void>;
		onBlockingAction: (sessionId: string, eventId: string, choice: string | number) => void;
		onSignOut: () => void;
	}
	let { token, templates, debugOpen, onToggleDebug, onSpawn, onSubmit, onAbort, onKill, onBlockingAction, onSignOut }: Props = $props();

	let spawnOpen = $state(false);

	function onKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === "n") {
			e.preventDefault();
			spawnOpen = true;
		}
	}

	async function handleSpawn(input: { cwd: string; initialPrompt: string; templateName?: string }) {
		await onSpawn(input);
		spawnOpen = false;
	}

	function toggleTheme() {
		app.theme = app.theme === "dark" ? "light" : "dark";
	}

	$effect(() => {
		document.documentElement.setAttribute("data-theme", app.theme);
	});
</script>

<svelte:window onkeydown={onKey} />

<div class="shell">
	<aside class="rail-host">
		<SessionList onSpawn={() => (spawnOpen = true)} />
	</aside>
	<main class="main">
		{#if app.current}
			<ChatPane
				sessionState={app.current}
				{token}
				onSubmit={(text) => onSubmit(app.current!.summary.sessionId, text)}
				onAbort={() => onAbort(app.current!.summary.sessionId)}
				onKill={() => onKill(app.current!.summary.sessionId)}
				onBlockingAction={(eventId, choice) => onBlockingAction(app.current!.summary.sessionId, eventId, choice)}
			/>
		{:else}
			<div class="placeholder muted">
				<div>
					<p>Select a session, or press <span class="kbd">⌘N</span> to spawn one.</p>
					{#if app.identity}<p class="small">Signed in as <span class="mono">{app.identity}</span></p>{/if}
				</div>
			</div>
		{/if}
	</main>
	<footer class="statusbar">
		<span class="left">
			{app.sessions.size} session{app.sessions.size === 1 ? "" : "s"}
		</span>
		<span class="spacer"></span>
		<button class="btn btn-ghost small" onclick={toggleTheme} title="Toggle theme">
			{app.theme === "dark" ? "☀" : "🌙"}
		</button>
		<button class="btn btn-ghost small" onclick={() => onToggleDebug(!debugOpen)} title="Toggle debug">
			{debugOpen ? "🐛" : "Debug"}
		</button>
		<button class="btn btn-ghost small" onclick={onSignOut}>Sign out</button>
	</footer>

	{#if spawnOpen}
		<SpawnDialog {templates} onCancel={() => (spawnOpen = false)} onSubmit={handleSpawn} />
	{/if}
	{#if debugOpen && app.current}
		<DebugPanel sessionState={app.current} onClose={() => onToggleDebug(false)} />
	{/if}
</div>

<style>
	.shell {
		display: grid;
		grid-template-columns: var(--rail-width) 1fr;
		grid-template-rows: 1fr var(--statusbar-height);
		grid-template-areas:
			"rail main"
			"status status";
		height: 100vh;
		min-height: 0;
	}
	.rail-host { grid-area: rail; min-height: 0; }
	.main { grid-area: main; min-height: 0; display: grid; }
	.placeholder {
		display: grid;
		place-items: center;
		height: 100%;
		text-align: center;
	}
	.placeholder p { margin: 4px 0; }
	.placeholder .small { font-size: var(--font-size-xs); }
	.statusbar {
		grid-area: status;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px;
		border-top: 1px solid var(--border-secondary);
		background: var(--bg-secondary);
		font-size: var(--font-size-xs);
	}
	.statusbar .left { color: var(--text-secondary); }
	.spacer { flex: 1; }
	.btn.small { padding: 3px 8px; font-size: var(--font-size-xs); }
</style>
