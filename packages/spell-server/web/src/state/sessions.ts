import { create } from "zustand";
import type { ArtifactRef, BlockingEventPayload, SessionSummary, DisciplineRuntimeStat, DisciplineGateOutcome } from "../api/client";

export type SessionStatus = "spawning" | "running" | "done" | "error";

export interface DerivedSession extends SessionSummary {
	status: SessionStatus;
	ready: boolean;
	lastText?: string;
	artifacts: ArtifactRef[];
	logs: Array<{ kind: string; ts: number; text?: string; toolName?: string; meta?: Record<string, string | number | boolean> }>;
	disciplineStats?: DisciplineRuntimeStat[] | null;
	lastDisciplineOutcomes?: DisciplineGateOutcome[] | null;
}

interface SessionsState {
	sessions: Map<string, DerivedSession>;
	selected: string | null;
	setAll: (sessions: SessionSummary[]) => void;
	upsert: (summary: SessionSummary) => void;
	remove: (sessionId: string) => void;
	select: (sessionId: string | null) => void;
	addArtifact: (sessionId: string, artifact: ArtifactRef) => void;
	setArtifacts: (sessionId: string, artifacts: ArtifactRef[]) => void;
	pushLog: (sessionId: string, entry: DerivedSession["logs"][number]) => void;
	noteEvent: (sessionId: string, event: { type: string; assistantMessageEvent?: { type: string; delta?: string; content?: string } }) => void;
	markReady: (sessionId: string) => void;
	setBlockingEvent: (sessionId: string, event: BlockingEventPayload | undefined) => void;
	setDisciplineStats: (sessionId: string, stats: DisciplineRuntimeStat[] | null | undefined) => void;
}

function lift(summary: SessionSummary): DerivedSession {
	return {
		...summary,
		status: summary.kind === "spawned" ? "spawning" : "running",
		ready: false,
		lastText: undefined,
		artifacts: [],
		logs: [],
	};
}

export const useSessions = create<SessionsState>((set) => ({
	sessions: new Map(),
	selected: null,
	setAll: list =>
		set(state => {
			const next = new Map<string, DerivedSession>();
			for (const summary of list) {
				const existing = state.sessions.get(summary.sessionId);
				next.set(summary.sessionId, existing ? { ...existing, ...summary } : lift(summary));
			}
			return { sessions: next };
		}),
	upsert: summary =>
		set(state => {
			const next = new Map(state.sessions);
			const existing = next.get(summary.sessionId);
			next.set(summary.sessionId, existing ? { ...existing, ...summary } : lift(summary));
			return { sessions: next };
		}),
	remove: sessionId =>
		set(state => {
			const next = new Map(state.sessions);
			next.delete(sessionId);
			const selected = state.selected === sessionId ? null : state.selected;
			return { sessions: next, selected };
		}),
	select: sessionId => set({ selected: sessionId }),
	addArtifact: (sessionId, artifact) =>
		set(state => {
			const sess = state.sessions.get(sessionId);
			if (!sess) return state;
			if (sess.artifacts.some(a => a.uri === artifact.uri)) return state;
			const next = new Map(state.sessions);
			next.set(sessionId, { ...sess, artifacts: [...sess.artifacts, artifact] });
			return { sessions: next };
		}),
	setArtifacts: (sessionId, artifacts) =>
		set(state => {
			const sess = state.sessions.get(sessionId);
			if (!sess) return state;
			const next = new Map(state.sessions);
			next.set(sessionId, { ...sess, artifacts });
			return { sessions: next };
		}),
	pushLog: (sessionId, entry) =>
		set(state => {
			const sess = state.sessions.get(sessionId);
			if (!sess) return state;
			const next = new Map(state.sessions);
			const logs = [...sess.logs, entry].slice(-200);
			// Derive live status for external (terminal) sessions from their event
			// stream so the sidebar badge reflects streaming vs idle.
			let status = sess.status;
			if (entry.kind === "turn_start" || entry.kind === "tool_call" || entry.kind === "user_message") {
				status = "running";
			} else if (entry.kind === "turn_end") {
				status = "done";
			} else if (entry.kind === "error") {
				status = "error";
			}
			next.set(sessionId, {
				...sess,
				logs,
				status,
				lastText: entry.text ?? sess.lastText,
			});
			return { sessions: next };
		}),
	noteEvent: (sessionId, event: any) =>
		set(state => {
			const sess = state.sessions.get(sessionId);
			if (!sess) return state;
			const next = new Map(state.sessions);
			let updated: DerivedSession = sess;
			if (event.type === "agent_start" && sess.status !== "done" && sess.status !== "error") {
				updated = { ...updated, status: "running" };
			}
			if (event.type === "agent_end") {
				updated = { ...updated, status: "done" };
			}
			if (event.type === "error") {
				updated = { ...updated, status: "error" };
			}
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				const delta = event.assistantMessageEvent.delta ?? "";
				updated = { ...updated, lastText: ((updated.lastText ?? "") + delta).slice(-256) };
			}
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_end") {
				updated = { ...updated, lastText: (event.assistantMessageEvent.content ?? "").slice(-256) };
			}
			if (event.type === "yield_reminder" && event.stats) {
				updated = { ...updated, disciplineStats: event.stats, lastDisciplineOutcomes: event.outcomes || null };
			}
			next.set(sessionId, updated);
			return { sessions: next };
		}),
	markReady: sessionId =>
		set(state => {
			const sess = state.sessions.get(sessionId);
			if (!sess) return state;
			const next = new Map(state.sessions);
			next.set(sessionId, { ...sess, ready: true });
			return { sessions: next };
		}),
	setBlockingEvent: (sessionId, event) =>
		set(state => {
			const sess = state.sessions.get(sessionId);
			if (!sess) return state;
			const next = new Map(state.sessions);
			next.set(sessionId, { ...sess, currentBlockingEvent: event });
			return { sessions: next };
		}),
	setDisciplineStats: (sessionId, stats) =>
		set(state => {
			const sess = state.sessions.get(sessionId);
			if (!sess) return state;
			const next = new Map(state.sessions);
			next.set(sessionId, { ...sess, disciplineStats: stats ?? null });
			return { sessions: next };
		}),
}));
