<script lang="ts">
	import { onMount } from "svelte";
	import { api, tokenStore, type ManifestTemplate } from "./lib/api";
	import { app, toasts } from "./lib/stores.svelte";
	import type {
		BridgeRpcCommand,
		RunStoredResult,
		TileCreateResult,
		TileListResult,
		TileUpdateResult,
	} from "./lib/protocol";
	import { buildWsUrl, WsClient } from "./lib/ws";
	import Login from "./components/Login.svelte";
	import Shell from "./components/Shell.svelte";
	import Toast from "./components/Toast.svelte";

	let token = $state<string | null>(tokenStore.get());
	let ws: WsClient | null = $state(null);
	let templates = $state<ManifestTemplate[]>([]);
	let debugOpen = $state(false);

	function connect(t: string): void {
		token = t;
		const client = new WsClient({
			url: buildWsUrl(t),
			onStatus: status => {
				app.wsStatus = status;
				if (status === "auth_ok") {
					client.send({ type: "list_sessions" });
					void api.listTemplates(t).then(r => (templates = r.templates)).catch(() => {});
				}
			},
			onMessage: msg => {
				switch (msg.type) {
					case "auth_ok":
						app.identity = msg.identity.name;
						break;
					case "session_list":
						app.setAll(msg.sessions);
						for (const s of msg.sessions) {
							const channels: string[] = s.kind === "spawned" ? ["events", "artifacts", "state"] : ["events", "artifacts"];
							if (debugOpen) channels.push("debug");
							client.send({
								type: "subscribe",
								sessionId: s.sessionId,
								channels: channels as import("./lib/protocol").Channel[],
								artifactExt: s.watchExtensions,
							});
						}
						break;
					case "session_added": {
						app.upsert(msg.session);
						const channels: string[] = msg.session.kind === "spawned" ? ["events", "artifacts", "state"] : ["events", "artifacts"];
						if (debugOpen) channels.push("debug");
						client.send({
							type: "subscribe",
							sessionId: msg.session.sessionId,
							channels: channels as import("./lib/protocol").Channel[],
							artifactExt: msg.session.watchExtensions,
						});
						if (!app.selected) app.select(msg.session.sessionId);
						break;
					}
					case "session_updated":
						app.upsert(msg.session);
						break;
					case "session_removed":
						app.remove(msg.session.sessionId);
						break;
					case "rpc_event":
						app.noteRpcEvent(msg.sessionId, msg.event);
						break;
					case "external_event_log":
						app.noteExternalLog(msg.sessionId, msg.entry);
						break;
					case "blocking_event":
						app.noteBlocking(msg.sessionId, msg.payload);
						break;
					case "artifact_created":
						app.noteArtifact(msg.sessionId, msg.artifact);
						break;
					case "process_info":
						app.noteProcessInfo(msg.sessionId, { pid: msg.pid, rssBytes: msg.rssBytes, cpuPercent: msg.cpuPercent, uptimeMs: msg.uptimeMs, ts: msg.ts });
						break;
					case "rpc_stderr":
						app.noteStderr(msg.sessionId, msg.line, msg.ts);
						break;
					case "error":
						if (msg.code === "auth_failed" || msg.code === "unauthorized") {
							signOut();
							toasts.push("error", "Authentication failed — sign in again");
						} else if (!msg.correlationId) {
							// Correlated errors are raised by ws.request() callers.
							toasts.push("error", `${msg.code}: ${msg.message}`);
						}
						break;
				}
			},
		});
		ws = client;
	}

	onMount(() => {
		if (token) connect(token);
		return () => {
			ws?.dispose();
			ws = null;
		};
	});

	async function onSpawn(input: { cwd: string; initialPrompt: string; templateName?: string }) {
		if (!ws) throw new Error("not connected");
		try {
			const result = await ws.request(
				{
					type: "spawn",
					cwd: input.cwd,
					initialPrompt: input.initialPrompt || undefined,
					templateName: input.templateName,
					ownedBy: app.identity ?? undefined,
				},
				60_000,
			);
			if (result.type === "spawn_result") {
				app.select(result.sessionId);
				toasts.push("success", `Spawned session ${result.sessionId}`);
			}
		} catch (err) {
			toasts.push("error", String((err as Error).message ?? err));
			throw err;
		}
	}

	async function onSubmit(sessionId: string, text: string) {
		if (!ws) return;
		app.pushUserPrompt(sessionId, text);
		await ws.request({
			type: "rpc",
			sessionId,
			command: { type: "prompt", message: text },
		}).catch(err => toasts.push("error", String(err)));
	}

	function onAbort(sessionId: string) {
		ws?.send({ type: "rpc", sessionId, command: { type: "abort" } });
	}

	// W4 stored-program tile: run a stored PTC-Lisp program through the agent's
	// intent-gated runner (no LLM turn) and return the structured result the tile
	// renders (preview / committed / rolled-back). Targets a spawned session.
	async function onRunStored(
		sessionId: string,
		req: {
			program: string;
			mode?: "read" | "write";
			intent?: "interactive" | "visible-refresh" | "background-tick";
			autoWrite?: boolean;
		},
	): Promise<RunStoredResult> {
		if (!ws) throw new Error("not connected");
		const result = await ws.request({
			type: "rpc",
			sessionId,
			command: { type: "run_stored", ...req },
		});
		return unwrapRpc<RunStoredResult>(result, "run_stored");
	}

	// Shared unwrap for rpc_response frames. The wire field is `success`
	// (RpcResponseEvent), NOT `ok`; an agent-side error carries success:false +
	// an `error` string and NO data — surface that string rather than returning
	// undefined and crashing the caller.
	function unwrapRpc<T>(result: { type: string; response?: unknown }, label: string): T {
		if (result.type !== "rpc_response") throw new Error("unexpected response");
		const resp = result.response as { success?: boolean; error?: string; data?: unknown };
		if (resp.success === false) throw new Error(resp.error ?? `${label} failed`);
		if (!resp.data) throw new Error(`${label} returned no result`);
		return resp.data as T;
	}

	// Tile persistence (FUP-123) — config CRUD + history over the same rpc lane.
	async function onTileList(sessionId: string, project?: string): Promise<TileListResult> {
		if (!ws) throw new Error("not connected");
		const result = await ws.request({ type: "rpc", sessionId, command: { type: "tile_list", project } });
		return unwrapRpc<TileListResult>(result, "tile_list");
	}
	async function onTileCreate(
		sessionId: string,
		tile: Extract<BridgeRpcCommand, { type: "tile_create" }>["tile"],
	): Promise<TileCreateResult> {
		if (!ws) throw new Error("not connected");
		const result = await ws.request({ type: "rpc", sessionId, command: { type: "tile_create", tile } });
		return unwrapRpc<TileCreateResult>(result, "tile_create");
	}
	async function onTileUpdate(
		sessionId: string,
		tileId: string,
		patch: Record<string, unknown>,
	): Promise<TileUpdateResult> {
		if (!ws) throw new Error("not connected");
		const result = await ws.request({ type: "rpc", sessionId, command: { type: "tile_update", tileId, patch } });
		const data = unwrapRpc<TileUpdateResult>(result, "tile_update");
		// The store signals a non-applied mutation with ok:false (NOT a thrown error)
		// — surface it so the caller's revert path fires instead of keeping a stale
		// optimistic state.
		if (data.ok === false) throw new Error("tile_update did not apply");
		return data;
	}
	async function onTileRecordRun(
		sessionId: string,
		tileId: string,
		run: { intent: string; outcome: string; files: number; paths?: string[]; error?: string },
	): Promise<void> {
		if (!ws) throw new Error("not connected");
		const result = await ws.request({ type: "rpc", sessionId, command: { type: "tile_record_run", tileId, run } });
		unwrapRpc<{ ok: boolean }>(result, "tile_record_run");
	}
	async function onTileDelete(sessionId: string, tileId: string): Promise<void> {
		if (!ws) throw new Error("not connected");
		const result = await ws.request({ type: "rpc", sessionId, command: { type: "tile_delete", tileId } });
		// Delete is IDEMPOTENT: ok:false = the tile file was already absent server-side,
		// which matches the user's intent (it's gone). Reverting the optimistic removal
		// would resurrect a phantom tile with no server backing — so we do NOT throw on
		// ok:false here. A genuine delete failure surfaces as an rpc error (unwrapRpc).
		unwrapRpc<{ ok: boolean }>(result, "tile_delete");
	}

	async function onKill(sessionId: string) {
		if (!token) return;
		await api.killSession(token, sessionId);
		app.remove(sessionId);
		toasts.push("info", "Session killed");
	}

	function onBlockingAction(sessionId: string, eventId: string, choice: string | number) {
		ws?.send({
			type: "answer_blocking_event",
			sessionId,
			eventId,
			payload: { eventId, choice },
		});
		app.clearBlocking(sessionId);
	}

	function signOut() {
		tokenStore.clear();
		ws?.dispose();
		ws = null;
		token = null;
		app.setAll([]);
		app.identity = null;
		app.wsStatus = "closed";
	}
</script>

{#if token}
	<Shell
		{token}
		{templates}
		{debugOpen}
		onToggleDebug={(open: boolean) => {
			debugOpen = open;
			if (!ws || !app.current) return;
			if (open) {
				ws.send({ type: "subscribe", sessionId: app.current.summary.sessionId, channels: ["debug"] });
			} else {
				ws.send({ type: "unsubscribe", sessionId: app.current.summary.sessionId, channels: ["debug"] });
			}
		}}
		{onSpawn}
		{onSubmit}
		{onAbort}
		{onKill}
		{onRunStored}
		{onTileList}
		{onTileCreate}
		{onTileUpdate}
		{onTileRecordRun}
		{onTileDelete}
		{onBlockingAction}
		onSignOut={signOut}
	/>
{:else}
	<Login onLogin={connect} />
{/if}

<Toast />
