<script lang="ts">
	// Codemod tiles (W4-write / FUP-119): a saved PTC-Lisp WRITE program that the
	// dev keeps and re-applies. On open, each tile runs a visible-refresh DRY RUN
	// ("would change N files") — a live drift signal that never mutates. [Apply]
	// runs it for real (interactive, transactional). An "auto-apply" toggle arms
	// the tile so a background tick could run it unattended (the agent issues that
	// tick; the toggle is the per-tile opt-in). Every real write leaves an audit
	// line; rolled-back / discarded outcomes are shown with equal weight to
	// commits.
	//
	// Persistence (FUP-123): tile config is a server-side ORG ITEM (via tile_* rpc),
	// run history is a server-side MEMORY EPISODE. localStorage is the OFFLINE
	// FALLBACK only — it caches the last-known tiles so the panel still renders when
	// the agent is unreachable, but the server is the source of truth.
	import type {
		RunStoredResult,
		TileCreateResult,
		TileListResult,
		TileUpdateResult,
		TxnOutcome,
	} from "../lib/protocol";

	interface Props {
		sessionId: string;
		onRunStored: (
			sessionId: string,
			req: {
				program: string;
				mode?: "read" | "write";
				intent?: "interactive" | "visible-refresh" | "background-tick";
				autoWrite?: boolean;
			},
		) => Promise<RunStoredResult>;
		onTileList: (sessionId: string, project?: string) => Promise<TileListResult>;
		onTileCreate: (
			sessionId: string,
			tile: {
				title: string;
				kind?: "codemod" | "format";
				programInline?: string;
				mode: "read" | "write";
				autoWrite: boolean;
			},
		) => Promise<TileCreateResult>;
		onTileUpdate: (sessionId: string, tileId: string, patch: Record<string, unknown>) => Promise<TileUpdateResult>;
		onTileRecordRun: (
			sessionId: string,
			tileId: string,
			run: { intent: string; outcome: string; files: number; paths?: string[]; error?: string },
		) => Promise<void>;
		onTileDelete: (sessionId: string, tileId: string) => Promise<void>;
		onClose: () => void;
	}
	let {
		sessionId,
		onRunStored,
		onTileList,
		onTileCreate,
		onTileUpdate,
		onTileRecordRun,
		onTileDelete,
		onClose,
	}: Props = $props();

	interface AuditLine {
		ts: number;
		outcome: TxnOutcome["outcome"];
		files: number;
	}
	type TileKind = "codemod" | "format";
	interface Tile {
		id: string;
		title: string;
		kind: TileKind;
		program: string;
		autoWrite: boolean;
		// Live (not persisted across the run): the latest preview/apply result.
		preview?: TxnOutcome | null;
		previewError?: string | null;
		busy?: boolean;
		// True once an auto dry-run has been ATTEMPTED (success OR failure), so the
		// on-open effect fires exactly once per tile and never storms on a failing
		// program / transient disconnect. Reset when the program is edited.
		checked?: boolean;
		history: AuditLine[];
	}

	const STORE_KEY = "spell.codemod-tiles.v1";

	// Offline fallback ONLY: cache the last-known tiles so the panel renders when
	// the agent is unreachable. The server (org item) is the source of truth.
	function loadCache(): Tile[] {
		try {
			const raw = localStorage.getItem(STORE_KEY);
			if (!raw) return [];
			const parsed = JSON.parse(raw) as Tile[];
			// Default kind for caches written before the `kind` field existed (or any
			// malformed entry) so a stale cache never renders an "undefined" badge.
			return parsed.map(t => ({
				...t,
				kind: t.kind === "format" ? "format" : "codemod",
				preview: undefined,
				previewError: null,
				busy: false,
				checked: false,
			}));
		} catch {
			return [];
		}
	}
	function writeCache() {
		const durable = tiles.map(t => ({
			id: t.id,
			title: t.title,
			kind: t.kind,
			program: t.program,
			autoWrite: t.autoWrite,
			history: t.history.slice(0, 20),
		}));
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(durable));
		} catch {
			/* localStorage full / unavailable — non-fatal */
		}
	}

	// Map a server TileRecord into the local Tile view model.
	function fromRecord(r: TileListResult["tiles"][number]): Tile {
		const hist: AuditLine[] =
			r.lastOutcome && r.lastRunAt
				? [{ ts: Date.parse(r.lastRunAt) || Date.now(), outcome: r.lastOutcome, files: r.lastFiles ?? 0 }]
				: [];
		return {
			id: r.id,
			title: r.title,
			kind: r.kind === "format" ? "format" : "codemod",
			program: r.programInline ?? "",
			autoWrite: r.autoWrite,
			history: hist,
		};
	}

	let tiles = $state<Tile[]>(loadCache());
	let editing = $state<string | null>(null);
	let draftTitle = $state("");
	let draftProgram = $state("");
	let draftKind = $state<TileKind>("codemod");
	let loadError = $state<string | null>(null);

	// Load the authoritative tile set from the server ONCE per session id. Gated on
	// `loadedFor` so reactive ticks don't re-fire the load and clobber local edits;
	// a genuine session switch (sessionId change) re-runs it for the new session.
	let loadedFor = $state<string | null>(null);
	$effect(() => {
		const sid = sessionId;
		if (loadedFor === sid) return;
		loadedFor = sid;
		void (async () => {
			try {
				const res = await onTileList(sid);
				const serverTiles = res.tiles.map(fromRecord);
				if (serverTiles.length === 0 && tiles.length > 0) {
					// MIGRATION: the server store is empty but we have cached (pre-FUP-123,
					// localStorage-only) tiles. Push them to the server so they are not lost,
					// then adopt the server ids. Never overwrite a non-empty cache with empty.
					const migrated: Tile[] = [];
					for (const t of tiles) {
						try {
							const { tileId } = await onTileCreate(sid, {
								title: t.title,
								kind: t.kind,
								programInline: t.program,
								mode: "write",
								autoWrite: t.autoWrite,
							});
							migrated.push({ ...t, id: tileId, checked: false, preview: undefined });
						} catch {
							migrated.push(t); // keep the local tile if migration of this one fails
						}
					}
					tiles = migrated;
				} else {
					tiles = serverTiles;
				}
				loadError = null;
				writeCache();
			} catch (e) {
				// Keep the cached tiles; surface that we're showing stale/offline data.
				// loadedFor stays set so we don't spin; the user reopens to retry.
				loadError = String((e as Error)?.message ?? e);
			}
		})();
	});

	// A real, rollback-safe FORMAT program: normalize whitespace hygiene across the
	// tree using ONLY file reads + writes (no shelling to prettier — that fails the
	// rollback-safe bar). Trims trailing whitespace per line and ensures a single
	// final newline. Full prettier-style reformatting awaits the WASM formatter
	// (Q-formatter, P3-adjacent); this is the shippable hygiene sweep today.
	const FORMAT_STARTER = `; Whitespace hygiene sweep — rollback-safe (file reads + writes only).
; Edit the glob to scope it. Dry-run shows "would change N files"; Apply commits.
(->> (get (tool/find {:target "src/**/*.ts"}) "hits")
     (map (fn [path]
            (let [orig (get (tool/find {:target (str path "#raw")}) "text")
                  trimmed (join "\n" (map trimr (split-lines orig)))
                  fixed (str (trim-newline trimmed) "\n")]
              (when (not= orig fixed)
                (tool/edit {:operations [{:target path
                                          :action {:kind "replace" :content fixed}}]})
                path))))
     (filter some?)
     (count))`;

	const CODEMOD_STARTER = "";

	function newTile(kind: TileKind = "codemod") {
		editing = "__new__";
		draftKind = kind;
		draftTitle = "";
		draftProgram = kind === "format" ? FORMAT_STARTER : CODEMOD_STARTER;
	}
	function editTile(t: Tile) {
		editing = t.id;
		draftKind = t.kind;
		draftTitle = t.title;
		draftProgram = t.program;
	}
	let mutateError = $state<string | null>(null);

	async function saveDraft() {
		const title = draftTitle.trim() || (draftKind === "format" ? "format sweep" : "untitled codemod");
		const program = draftProgram.trim();
		if (!program) return;
		const wasEditing = editing;
		editing = null;
		mutateError = null;
		try {
			if (wasEditing === "__new__") {
				// Create server-side, then add the returned TILE-* id locally.
				const { tileId } = await onTileCreate(sessionId, {
					title,
					kind: draftKind,
					programInline: program,
					mode: "write",
					autoWrite: false,
				});
				tiles.push({ id: tileId, title, kind: draftKind, program, autoWrite: false, history: [] });
			} else {
				const t = tiles.find(x => x.id === wasEditing);
				if (t) {
					t.title = title;
					t.program = program;
					t.preview = undefined; // program changed → stale preview
					t.previewError = null;
					t.checked = false; // re-preview the edited program on next effect tick
					await onTileUpdate(sessionId, t.id, { title, programInline: program });
				}
			}
			writeCache();
		} catch (e) {
			mutateError = `save failed: ${String((e as Error)?.message ?? e)}`;
		}
	}
	async function deleteTile(id: string) {
		const prev = tiles;
		tiles = tiles.filter(t => t.id !== id);
		mutateError = null;
		try {
			await onTileDelete(sessionId, id);
			writeCache();
		} catch (e) {
			tiles = prev; // restore on failure — never silently lose a tile
			mutateError = `delete failed: ${String((e as Error)?.message ?? e)}`;
		}
	}

	// Run a tile with a given intent. visible-refresh → preview (no mutation);
	// interactive → apply for real; background-tick → only when armed.
	async function run(t: Tile, intent: "interactive" | "visible-refresh") {
		t.busy = true;
		t.previewError = null;
		try {
			const res = await onRunStored(sessionId, {
				program: t.program,
				mode: "write",
				intent,
			});
			t.preview = res.transaction;
			t.checked = true;
			if (intent === "interactive" && res.transaction) {
				// Real run → record an audit line (commit OR rollback, equal weight).
				t.history = [
					{ ts: Date.now(), outcome: res.transaction.outcome, files: res.transaction.files },
					...t.history,
				].slice(0, 20);
				writeCache();
				// Persist the run to the server (memory episode + last-outcome cache).
				// Best-effort: a failed audit write must not break the apply UX.
				void onTileRecordRun(sessionId, t.id, {
					intent,
					outcome: res.transaction.outcome,
					files: res.transaction.files,
					paths: res.transaction.paths,
				}).catch(() => {});
			}
		} catch (e) {
			t.previewError = String((e as Error)?.message ?? e);
			// Mark checked even on failure so the on-open effect does NOT re-fire in a
			// storm; the user can retry explicitly via the ↻ button.
			t.checked = true;
		} finally {
			t.busy = false;
		}
	}

	async function toggleAuto(t: Tile) {
		const next = !t.autoWrite;
		t.autoWrite = next;
		mutateError = null;
		try {
			await onTileUpdate(sessionId, t.id, { autoWrite: next });
			writeCache();
		} catch (e) {
			t.autoWrite = !next; // revert on failure — the arm state must reflect reality
			mutateError = `arm toggle failed: ${String((e as Error)?.message ?? e)}`;
		}
	}

	// On open, dry-run every tile ONCE to surface drift (visible-refresh). Gated on
	// `checked` (set on success AND failure) so a failing program or a transient
	// disconnect can never trigger a retry storm — the ↻ button is the explicit retry.
	$effect(() => {
		for (const t of tiles) {
			if (!t.checked && !t.busy) void run(t, "visible-refresh");
		}
	});

	function driftLabel(t: Tile): { text: string; tone: "clean" | "drift" | "error" | "pending" } {
		if (t.busy && t.preview === undefined) return { text: "checking…", tone: "pending" };
		if (t.previewError) return { text: "preview failed", tone: "error" };
		const p = t.preview;
		if (!p) return { text: "not yet checked", tone: "pending" };
		if (p.outcome === "dry-run" && p.files > 0) return { text: `would change ${p.files} file${p.files === 1 ? "" : "s"}`, tone: "drift" };
		if (p.outcome === "committed") return { text: `committed ${p.files} file${p.files === 1 ? "" : "s"}`, tone: "clean" };
		if (p.outcome === "rolled-back") return { text: "rolled back — repo unchanged", tone: "error" };
		return { text: "no drift", tone: "clean" };
	}

	function fmtTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	function outcomeGlyph(o: TxnOutcome["outcome"]): string {
		return o === "committed" ? "✓" : o === "rolled-back" ? "↩" : o === "dry-run" ? "≈" : o === "inert" ? "·" : "–";
	}
</script>

<div class="panel">
	<div class="header">
		<h2>Tiles</h2>
		<div class="hgap"></div>
		<button class="btn-mini" onclick={() => newTile("codemod")} title="New codemod tile">+ Codemod</button>
		<button class="btn-mini" onclick={() => newTile("format")} title="New format/hygiene tile">+ Format</button>
		<button class="close" onclick={onClose} aria-label="Close codemods panel">✕</button>
	</div>

	<div class="body">
		{#if loadError}
			<p class="banner offline" title={loadError}>
				⚠ Offline — showing cached tiles. Changes won't persist until the agent reconnects.
			</p>
		{/if}
		{#if mutateError}
			<p class="banner error">{mutateError}</p>
		{/if}
		{#if editing}
			<div class="editor">
				<input class="title-in" bind:value={draftTitle} placeholder="Tile title (e.g. migrate oldLog → logger.info)" />
				<textarea
					class="prog-in"
					bind:value={draftProgram}
					rows="8"
					spellcheck="false"
					placeholder={"(->> (tool/find {:target \"src/**/*.ts::§call[name=oldLog]\"})\n     (map (fn [hit] (tool/edit …)))\n     (count))"}
				></textarea>
				<p class="hint muted">
					{#if draftKind === "format"}
						A <strong>format</strong> sweep: a rollback-safe whitespace/hygiene normalization (file
						reads + writes only). Edit the glob to scope it. Full reformatting awaits the WASM formatter.
					{:else}
						A <strong>write</strong> program: file edits/creates only (mixing with org/memory mutations is rejected).
					{/if}
					It runs as a dry-run preview here; <strong>Apply</strong> commits it transactionally.
				</p>
				<div class="row">
					<button class="btn" onclick={() => (editing = null)}>Cancel</button>
					<button class="btn btn-primary" onclick={saveDraft} disabled={!draftProgram.trim()}>Save</button>
				</div>
			</div>
		{:else if tiles.length === 0}
			<p class="muted empty">No tiles yet. Create a <button class="link" onclick={() => newTile("codemod")}>codemod</button> or a <button class="link" onclick={() => newTile("format")}>format sweep</button> to keep a transform you can re-apply on drift.</p>
		{:else}
			{#each tiles as t (t.id)}
				{@const drift = driftLabel(t)}
				<div class="tile" class:armed={t.autoWrite}>
					<div class="tile-head">
						<span class="kind-badge kind-{t.kind}" title={t.kind === "format" ? "Format/hygiene sweep" : "Codemod transform"}>{t.kind}</span>
						<span class="tile-title" title={t.title}>{t.title}</span>
						<button class="icon" onclick={() => editTile(t)} title="Edit">✎</button>
						<button class="icon" onclick={() => deleteTile(t.id)} title="Delete">🗑</button>
					</div>

					<div class="drift drift-{drift.tone}">
						{#if drift.tone === "drift"}⚠{/if}
						{#if drift.tone === "clean"}✓{/if}
						{#if drift.tone === "error"}✕{/if}
						<span>{drift.text}</span>
					</div>

					{#if t.preview?.paths?.length}
						<div class="paths muted" title={t.preview.paths.join("\n")}>
							{t.preview.paths.slice(0, 4).map(p => p.split("/").pop()).join(" · ")}{t.preview.paths.length > 4 ? ` +${t.preview.paths.length - 4}` : ""}
						</div>
					{/if}
					{#if t.previewError}
						<div class="paths err">{t.previewError}</div>
					{/if}

					<div class="actions">
						<button
							class="btn btn-primary"
							onclick={() => run(t, "interactive")}
							disabled={t.busy || drift.tone !== "drift"}
							title={drift.tone === "drift" ? "Apply this transform (commits transactionally)" : "No drift to apply"}
						>
							{t.busy ? "…" : "Apply"}
						</button>
						<button
							class="btn btn-ghost"
							onclick={() => run(t, "visible-refresh")}
							disabled={t.busy}
							title="Re-check drift"
						>↻</button>
						<button
							class="toggle"
							class:on={t.autoWrite}
							onclick={() => toggleAuto(t)}
							title={t.autoWrite ? "Auto-apply armed — a background tick may apply this" : "Arm auto-apply (background ticks may apply unattended)"}
						>
							⏻ auto
						</button>
					</div>

					{#if t.history.length}
						<div class="history">
							{#each t.history.slice(0, 3) as h}
								<span class="audit audit-{h.outcome}">
									{outcomeGlyph(h.outcome)} {h.files} · {fmtTime(h.ts)}
								</span>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>

<style>
	.banner {
		margin: 0 0 var(--space-2, 8px);
		padding: 6px 10px;
		border-radius: 6px;
		font-size: var(--font-size-xs);
	}
	.banner.offline { background: var(--color-warning-bg, #3a2f10); color: var(--color-warning, #c93); }
	.banner.error { background: var(--color-error-bg, #3a1010); color: var(--color-error, #d66); }
	.kind-badge {
		flex: none;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--text-secondary);
	}
	.kind-badge.kind-format { color: var(--color-accent, #6ab); }
	.panel {
		position: fixed;
		top: 0; right: 0;
		width: 380px; height: 100vh;
		background: var(--bg-elevated);
		border-left: 1px solid var(--border-secondary);
		z-index: 50;
		display: grid;
		grid-template-rows: auto 1fr;
	}
	.header {
		display: flex; align-items: center; gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border-secondary);
	}
	.header h2 { margin: 0; font-size: var(--font-size-sm); }
	.hgap { flex: 1; }
	.btn-mini {
		padding: 3px 8px; font-size: var(--font-size-xs);
		border: 1px solid var(--border-secondary); border-radius: 4px;
		background: var(--bg-secondary); color: var(--text-primary); cursor: pointer;
	}
	.close { background: transparent; border: none; cursor: pointer; color: var(--text-secondary); }
	.body { padding: 10px; overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }

	.empty { font-size: var(--font-size-xs); }
	.link { background: none; border: none; color: var(--color-accent, #6ab); cursor: pointer; padding: 0; text-decoration: underline; }

	.editor { display: flex; flex-direction: column; gap: 8px; }
	.title-in {
		padding: 7px 9px; border-radius: 6px;
		border: 1px solid var(--border-primary);
		background: var(--bg-elevated); color: var(--text-primary);
		font-size: var(--font-size-sm);
	}
	.prog-in {
		padding: 8px; border-radius: 6px;
		border: 1px solid var(--border-primary);
		background: var(--bg-secondary); color: var(--text-primary);
		font-family: var(--font-mono); font-size: var(--font-size-xs);
		resize: vertical; white-space: pre;
	}
	.hint { font-size: var(--font-size-xs); line-height: 1.4; }
	.row { display: flex; justify-content: flex-end; gap: 8px; }

	.tile {
		border: 1px solid var(--border-secondary);
		border-radius: 8px; padding: 10px;
		display: flex; flex-direction: column; gap: 7px;
		background: var(--bg-secondary);
	}
	.tile.armed { border-color: var(--color-accent, #6ab); box-shadow: inset 2px 0 0 var(--color-accent, #6ab); }
	.tile-head { display: flex; align-items: center; gap: 6px; }
	.tile-title { flex: 1; font-size: var(--font-size-sm); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.icon { background: transparent; border: none; cursor: pointer; color: var(--text-secondary); font-size: var(--font-size-xs); }

	.drift { display: flex; align-items: center; gap: 6px; font-size: var(--font-size-sm); }
	.drift-clean { color: var(--color-success, #4a8); }
	.drift-drift { color: var(--color-warning, #c93); }
	.drift-error { color: var(--text-secondary); }
	.drift-pending { color: var(--text-secondary); font-style: italic; }

	.paths { font-size: var(--font-size-xs); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.paths.err { color: var(--color-error, #d55); white-space: normal; }

	.actions { display: flex; align-items: center; gap: 6px; }
	.btn { padding: 5px 12px; border-radius: 6px; border: 1px solid var(--border-primary); background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; font-size: var(--font-size-xs); }
	.btn:disabled { opacity: 0.45; cursor: default; }
	.btn-primary { background: var(--color-accent, #6ab); border-color: var(--color-accent, #6ab); color: #fff; }
	.btn-ghost { background: transparent; }
	.toggle {
		margin-left: auto; padding: 4px 9px; border-radius: 6px;
		border: 1px solid var(--border-secondary); background: transparent;
		color: var(--text-secondary); cursor: pointer; font-size: var(--font-size-xs);
	}
	.toggle.on { background: var(--color-accent, #6ab); border-color: var(--color-accent, #6ab); color: #fff; }

	.history { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 2px; }
	.audit { font-size: var(--font-size-xs); font-family: var(--font-mono); color: var(--text-secondary); }
	.audit-committed { color: var(--color-success, #4a8); }
	.audit-rolled-back { color: var(--color-warning, #c93); }
</style>
