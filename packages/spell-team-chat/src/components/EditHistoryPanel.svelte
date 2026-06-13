<script lang="ts">
	// Edit History panel (PLAN-338 B) — a live, read-only view of every edit the
	// session has made, across ALL workspaces it touched (the kernel's
	// session-unified log). Newest-first, grouped by undo-group so a cross-file
	// rename reads as ONE operation, with committed badges (undo of a committed
	// file declines unless forced) and a quick filter. This is the human's
	// answer to "what did the agent change, and what can still be undone?".
	import type { EditHistoryEntry, EditHistoryResult } from "../lib/protocol";
	import { formatRelative } from "../lib/time";

	interface Props {
		sessionId: string;
		onEditHistory: (sessionId: string, file?: string) => Promise<EditHistoryResult>;
		onClose: () => void;
	}
	let { sessionId, onEditHistory, onClose }: Props = $props();

	let loading = $state(true);
	let error = $state<string | null>(null);
	let data = $state<EditHistoryResult | null>(null);
	let filter = $state("");
	// "all" | "undoable" | "redoable" | "committed"
	let lens = $state<"all" | "undoable" | "redoable" | "committed">("all");

	async function load() {
		loading = true;
		error = null;
		try {
			data = await onEditHistory(sessionId);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	// Reload whenever the panel binds to a (new) session.
	$effect(() => {
		// reference sessionId so the effect re-runs on session switch
		void sessionId;
		void load();
	});

	function baseName(p: string): string {
		const i = p.lastIndexOf("/");
		return i >= 0 ? p.slice(i + 1) : p;
	}
	function dirName(p: string): string {
		const i = p.lastIndexOf("/");
		return i > 0 ? p.slice(0, i) : "";
	}
	function relWorkspace(file: string, workspace: string): string {
		if (workspace && file.startsWith(workspace)) {
			const rel = file.slice(workspace.length).replace(/^\//, "");
			return rel || baseName(file);
		}
		return file;
	}
	function shortWs(ws: string): string {
		return baseName(ws) || ws;
	}

	interface Group {
		key: string;
		groupId: string | null;
		entries: EditHistoryEntry[];
		workspace: string;
		reverted: boolean;
		committed: boolean;
		newest: number;
		agentLabel: string;
	}

	// Filter → then collapse consecutive same-group entries into one row.
	const filtered = $derived.by<EditHistoryEntry[]>(() => {
		const entries = data?.entries ?? [];
		const f = filter.trim().toLowerCase();
		return entries.filter((e) => {
			if (lens === "undoable" && e.reverted) return false;
			if (lens === "redoable" && !e.reverted) return false;
			if (lens === "committed" && !e.committed) return false;
			if (f && !e.file.toLowerCase().includes(f)) return false;
			return true;
		});
	});

	const groups = $derived.by<Group[]>(() => {
		const out: Group[] = [];
		for (const e of filtered) {
			const last = out[out.length - 1];
			// Collapse into the previous row only when both share a non-null group id.
			if (last && e.groupId && last.groupId === e.groupId) {
				last.entries.push(e);
				last.reverted = last.reverted && e.reverted;
				last.committed = last.committed || e.committed;
				last.newest = Math.max(last.newest, e.timestamp);
				continue;
			}
			out.push({
				key: `${e.id}`,
				groupId: e.groupId,
				entries: [e],
				workspace: e.workspace,
				reverted: e.reverted,
				committed: e.committed,
				newest: e.timestamp,
				agentLabel: e.agentLabel,
			});
		}
		return out;
	});

	// Which group rows are expanded to show their member files.
	let expanded = $state<Set<string>>(new Set());
	function toggle(key: string) {
		const next = new Set(expanded);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expanded = next;
	}

	// A Group always has >= 1 entry by construction (see groups derivation).
	function firstOf(g: Group): EditHistoryEntry {
		return g.entries[0] as EditHistoryEntry;
	}

	function groupTitle(g: Group): string {
		const first = firstOf(g);
		if (g.entries.length === 1) return relWorkspace(first.file, g.workspace);
		const names = g.entries.map((e) => baseName(e.file));
		const uniq = [...new Set(names)];
		return uniq.length === 1 ? `${uniq[0]} ×${g.entries.length}` : `${g.entries.length} files`;
	}

	function copyId(id: string) {
		void navigator.clipboard?.writeText(id);
	}
</script>

<div class="panel" role="dialog" aria-label="Edit history">
	<header class="header">
		<h2>Edit History</h2>
		{#if data}
			<span class="counts">
				<span class="pill ok" title="Edits that can be undone">{data.undoable} undoable</span>
				{#if data.redoable > 0}
					<span class="pill muted" title="Undone edits that can be redone">{data.redoable} redoable</span>
				{/if}
			</span>
		{/if}
		<span class="hgap"></span>
		<button class="btn-mini" onclick={load} title="Refresh">↻</button>
		<button class="close" onclick={onClose} aria-label="Close">✕</button>
	</header>

	<div class="toolbar">
		<input
			class="filter"
			placeholder="Filter by file…"
			bind:value={filter}
			spellcheck="false"
			autocomplete="off"
		/>
		<div class="lenses">
			{#each [["all", "All"], ["undoable", "Undoable"], ["redoable", "Redoable"], ["committed", "Committed"]] as [key, label]}
				<button
					class="lens"
					class:active={lens === key}
					onclick={() => (lens = key as typeof lens)}
				>{label}</button>
			{/each}
		</div>
	</div>

	<div class="body">
		{#if loading}
			<div class="state muted">Loading edit history…</div>
		{:else if error}
			<div class="state err">{error}</div>
		{:else if !data || data.total === 0}
			<div class="state muted">No edits recorded in this session yet.</div>
		{:else if groups.length === 0}
			<div class="state muted">No edits match this filter.</div>
		{:else}
			<ul class="list">
				{#each groups as g (g.key)}
					{@const multi = g.entries.length > 1}
					{@const isOpen = expanded.has(g.key)}
					{@const first = firstOf(g)}
					<li class="row" class:reverted={g.reverted}>
						<button
							class="row-main"
							onclick={() => multi && toggle(g.key)}
							class:clickable={multi}
							title={multi ? "Show files in this operation" : first.file}
						>
							<span class="glyph" class:on={!g.reverted}>{g.reverted ? "↺" : "✓"}</span>
							<span class="titles">
								<span class="title">
									{#if multi}<span class="disclosure">{isOpen ? "▾" : "▸"}</span>{/if}
									{groupTitle(g)}
								</span>
								<span class="sub muted">
									<span class="ws">{shortWs(g.workspace)}</span>
									{#if !multi && dirName(relWorkspace(first.file, g.workspace))}
										<span class="dir">{dirName(relWorkspace(first.file, g.workspace))}/</span>
									{/if}
									{#if g.agentLabel}<span class="actor">· {g.agentLabel}</span>{/if}
									<span class="time">· {formatRelative(g.newest * 1000)}</span>
								</span>
							</span>
							<span class="badges">
								{#if multi}<span class="badge group" title="One operation, multiple files (undoes atomically)">group ×{g.entries.length}</span>{/if}
								{#if g.committed}<span class="badge committed" title="Committed to git — undo declines unless forced">committed</span>{/if}
							</span>
						</button>
						{#if multi && isOpen}
							<ul class="members">
								{#each g.entries as e (e.id)}
									<li class="member">
										<span class="glyph small" class:on={!e.reverted}>{e.reverted ? "↺" : "✓"}</span>
										<span class="mfile" title={e.file}>{relWorkspace(e.file, e.workspace)}</span>
										{#if e.committed}<span class="badge committed sm">committed</span>{/if}
										<button class="idchip" onclick={() => copyId(e.id)} title="Copy entry id for id-precise undo">#{e.id}</button>
									</li>
								{/each}
							</ul>
						{/if}
						{#if !multi}
							<button class="idchip floating" onclick={() => copyId(first.id)} title="Copy entry id for id-precise undo">#{first.id}</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<footer class="foot muted">
		<span>✓ applied · ↺ undone</span>
		<span class="hgap"></span>
		<span>Undo: ask the agent, or <code>edit · undo · id</code></span>
	</footer>
</div>

<style>
	.panel {
		position: fixed;
		top: 0;
		right: 0;
		width: 420px;
		height: 100vh;
		background: var(--bg-elevated);
		border-left: 1px solid var(--border-secondary);
		z-index: 50;
		display: grid;
		grid-template-rows: auto auto 1fr auto;
		box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
	}
	.header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border-secondary);
	}
	.header h2 {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
	}
	.counts { display: flex; gap: 6px; }
	.pill {
		font-size: 10px;
		padding: 1px 7px;
		border-radius: var(--radius-pill);
		font-weight: var(--font-weight-medium);
	}
	.pill.ok { background: color-mix(in srgb, var(--color-success) 16%, transparent); color: var(--color-success); }
	.pill.muted { background: var(--bg-tertiary); color: var(--text-secondary); }
	.hgap { flex: 1; }
	.btn-mini {
		padding: 3px 8px;
		font-size: var(--font-size-xs);
		border: 1px solid var(--border-secondary);
		border-radius: var(--radius-sm);
		background: var(--bg-secondary);
		color: var(--text-primary);
		cursor: pointer;
	}
	.btn-mini:hover { background: var(--bg-tertiary); }
	.close {
		background: transparent;
		border: none;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: var(--font-size-sm);
	}
	.close:hover { color: var(--text-primary); }

	.toolbar {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border-secondary);
	}
	.filter {
		padding: 6px 9px;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-primary);
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: var(--font-size-sm);
	}
	.filter:focus { outline: none; border-color: var(--border-accent); }
	.lenses { display: flex; gap: 4px; }
	.lens {
		flex: 1;
		padding: 4px 6px;
		font-size: var(--font-size-xs);
		border: 1px solid var(--border-secondary);
		border-radius: var(--radius-sm);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		cursor: pointer;
	}
	.lens:hover { background: var(--bg-tertiary); }
	.lens.active {
		background: var(--border-accent);
		border-color: var(--border-accent);
		color: var(--text-inverse);
	}

	.body { overflow: auto; min-height: 0; padding: 8px; }
	.state { padding: 24px 12px; text-align: center; font-size: var(--font-size-sm); }
	.state.err { color: var(--color-error); }
	.muted { color: var(--text-secondary); }

	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
	.row {
		position: relative;
		border: 1px solid var(--border-secondary);
		border-radius: var(--radius-md);
		background: var(--bg-secondary);
		overflow: hidden;
	}
	.row.reverted { opacity: 0.62; }
	.row-main {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		background: transparent;
		border: none;
		color: inherit;
		font: inherit;
		cursor: default;
	}
	.row-main.clickable { cursor: pointer; }
	.row-main.clickable:hover { background: var(--bg-tertiary); }
	.glyph {
		flex: none;
		width: 16px;
		text-align: center;
		color: var(--text-tertiary);
		font-size: var(--font-size-sm);
		line-height: 1.5;
	}
	.glyph.on { color: var(--color-success); }
	.glyph.small { font-size: var(--font-size-xs); width: 13px; }
	.titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.title {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.disclosure { color: var(--text-tertiary); margin-right: 2px; font-size: 10px; }
	.sub {
		font-size: var(--font-size-xs);
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		align-items: baseline;
	}
	.ws {
		font-family: var(--font-mono);
		font-size: 10px;
		padding: 0 5px;
		border-radius: var(--radius-sm);
		background: var(--bg-tertiary);
		color: var(--text-secondary);
	}
	.dir { font-family: var(--font-mono); font-size: 10px; }
	.actor { color: var(--text-link); }
	.badges { flex: none; display: flex; gap: 4px; align-items: center; }
	.badge {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 6px;
		border-radius: var(--radius-sm);
		font-weight: var(--font-weight-medium);
		white-space: nowrap;
	}
	.badge.group { background: color-mix(in srgb, var(--border-accent) 16%, transparent); color: var(--border-accent); }
	.badge.committed { background: color-mix(in srgb, var(--color-warning) 18%, transparent); color: var(--color-warning); }
	.badge.sm { font-size: 8px; padding: 1px 4px; }

	.members {
		list-style: none;
		margin: 0;
		padding: 2px 10px 8px 30px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		border-top: 1px dashed var(--border-secondary);
	}
	.member { display: flex; align-items: center; gap: 7px; font-size: var(--font-size-xs); }
	.mfile {
		flex: 1;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.idchip {
		flex: none;
		font-family: var(--font-mono);
		font-size: 10px;
		padding: 1px 5px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-secondary);
		background: var(--bg-elevated);
		color: var(--text-tertiary);
		cursor: pointer;
	}
	.idchip:hover { color: var(--text-primary); border-color: var(--border-primary); }
	.idchip.floating {
		position: absolute;
		top: 8px;
		right: 10px;
		opacity: 0;
		transition: opacity 0.12s;
	}
	.row:hover .idchip.floating { opacity: 1; }

	.foot {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 12px;
		border-top: 1px solid var(--border-secondary);
		font-size: 10px;
	}
	.foot code {
		font-family: var(--font-mono);
		background: var(--bg-tertiary);
		padding: 1px 5px;
		border-radius: var(--radius-sm);
	}
</style>
