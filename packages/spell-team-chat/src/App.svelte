<script lang="ts">
	import { onMount } from "svelte";
	import { api, tokenStore, type ManifestTemplate } from "./lib/api";
	import { app, toasts } from "./lib/stores.svelte";
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
		{onBlockingAction}
		onSignOut={signOut}
	/>
{:else}
	<Login onLogin={connect} />
{/if}

<Toast />
