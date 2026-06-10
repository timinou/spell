import type { EventBus } from "../utils/event-bus";
import { type AgentProgress, type SingleResult, TASK_SUBAGENT_PROGRESS_CHANNEL } from "./types";

interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: string;
	task: string;
	assignment?: string;
	progress: AgentProgress;
}

interface AskRaisedPayload {
	runId: string;
	questionId: string;
	fromTaskId: string;
	question: string;
	blocking: boolean;
}

interface AskAnsweredPayload {
	runId: string;
	questionId: string;
	answer: string;
	recipients: string[];
}

interface AskCancelledPayload {
	runId: string;
	questionId: string;
	reason: string;
}

export interface SubagentInfo {
	runningCount: number;
	pendingCount: number;
	totalCost: number;
	mostActiveAgent: {
		id: string;
		currentTool?: string;
		lastIntent?: string;
	} | null;
	/** Interactive-task asks awaiting an orchestrator answer (PLAN-327). */
	openAskCount: number;
}

/** A worker↔orchestrator dialogue entry surfaced in the TUI (PLAN-327). */
export interface AskDialogueEntry {
	questionId: string;
	fromTaskId: string;
	question: string;
	blocking: boolean;
	status: "pending" | "answered";
	answer?: string;
	recipients?: string[];
	raisedAtMs: number;
}

export interface SubagentLifetimeStats {
	totalLaunched: number;
	totalCompleted: number;
	totalFailed: number;
	totalAborted: number;
	totalTokens: number;
	totalCost: number;
	avgTokensPerSubtask: number;
	cacheHitRate: number;
	byAgentType: Map<string, { count: number; tokens: number; cost: number }>;
}

const TERMINAL_STATUSES: ReadonlySet<AgentProgress["status"]> = new Set([
	"completed",
	"completed-empty",
	"failed",
	"crashed",
	"timeout",
	"aborted",
	"cancelled",
	"policy-rejected",
	"depth-capped",
	"submit-result-missing",
	"schema-invalid",
	"gate_failed",
	"abandoned",
]);
const CHANGE_DEBOUNCE_MS = 100;

export class SubagentTracker {
	#activeAgents = new Map<string, AgentProgress>();
	#activeKeysBySignature = new Map<string, string>();
	#sessionKeys = new Map<string, string>();
	#launchedKeys = new Set<string>();
	#completedKeys = new Set<string>();
	#totalLaunched = 0;
	#totalCompleted = 0;
	#totalFailed = 0;
	#totalAborted = 0;
	#totalTokens = 0;
	#totalCost = 0;
	#totalCacheRead = 0;
	#totalCacheEligibleInput = 0;
	#byAgentType = new Map<string, { count: number; tokens: number; cost: number }>();
	#notifyTimer?: NodeJS.Timeout;
	#unsubscribe: () => void;
	#unsubscribeAsk: Array<() => void> = [];
	#onChange: () => void;
	#disposed = false;
	/** Ordered Q&A dialogue, keyed by questionId for in-place answer updates. */
	#asks = new Map<string, AskDialogueEntry>();

	constructor(eventBus: EventBus, onChange: () => void) {
		this.#onChange = onChange;
		this.#unsubscribe = eventBus.subscribe(TASK_SUBAGENT_PROGRESS_CHANNEL, raw => {
			this.#onProgress(raw as SubagentProgressPayload);
		});
		this.#unsubscribeAsk.push(
			eventBus.subscribe("task:ask:raised", raw => this.#onAskRaised(raw as AskRaisedPayload)),
			eventBus.subscribe("task:ask:answered", raw => this.#onAskAnswered(raw as AskAnsweredPayload)),
			eventBus.subscribe("task:ask:cancelled", raw => this.#onAskCancelled(raw as AskCancelledPayload)),
		);
	}

	recordCompletion(result: SingleResult): void {
		const signature = this.#resultSignature(result);
		const previousKey = this.#activeKeysBySignature.get(signature);
		const key = this.#resolveResultKey(result, previousKey);
		if (previousKey && previousKey !== key) {
			this.#migrateIdentity(previousKey, key);
		}
		this.#activeKeysBySignature.set(signature, key);
		this.#markLaunched(key);
		if (this.#completedKeys.has(key)) {
			return;
		}

		this.#completedKeys.add(key);
		this.#activeAgents.delete(key);
		this.#deleteSessionKey(result.sessionId, key);

		if (result.outcome === "aborted" || result.outcome === "cancelled") {
			this.#totalAborted += 1;
		} else if (result.outcome === "completed" || result.outcome === "completed-empty") {
			this.#totalCompleted += 1;
		} else {
			this.#totalFailed += 1;
		}

		const usage = result.usage;
		const tokens = usage?.totalTokens ?? result.tokens;
		const cost = usage?.cost?.total ?? 0;
		this.#totalTokens += tokens;
		this.#totalCost += cost;
		this.#totalCacheRead += usage?.cacheRead ?? 0;
		this.#totalCacheEligibleInput += (usage?.input ?? 0) + (usage?.cacheRead ?? 0);

		const agentStats = this.#byAgentType.get(result.agent) ?? { count: 0, tokens: 0, cost: 0 };
		agentStats.count += 1;
		agentStats.tokens += tokens;
		agentStats.cost += cost;
		this.#byAgentType.set(result.agent, agentStats);
		this.#scheduleChange();
	}

	getInfo(): SubagentInfo {
		const activeAgents = Array.from(this.#activeAgents.values());
		const pendingCount = activeAgents.filter(progress => progress.status === "pending").length;
		const runningAgents = activeAgents.filter(progress => progress.status === "running");
		const totalCost = runningAgents.reduce((sum, progress) => sum + (progress.usage?.cost ?? 0), 0);
		const mostActiveAgent = this.#selectMostActiveAgent(runningAgents);

		return {
			runningCount: runningAgents.length,
			pendingCount,
			totalCost,
			mostActiveAgent: mostActiveAgent
				? {
						id: mostActiveAgent.id,
						currentTool: mostActiveAgent.currentTool,
						lastIntent: mostActiveAgent.lastIntent,
					}
				: null,
			openAskCount: this.#openAskCount(),
		};
	}

	/** Full Q&A dialogue (PLAN-327), ordered by raise time, for viewers to render. */
	getAskDialogue(): AskDialogueEntry[] {
		return Array.from(this.#asks.values()).sort((a, b) => a.raisedAtMs - b.raisedAtMs);
	}

	/** Pending (unanswered) asks for a given task id. Filters the map directly (no sort). */
	getPendingAsksForTask(taskId: string): AskDialogueEntry[] {
		const out: AskDialogueEntry[] = [];
		for (const ask of this.#asks.values()) {
			if (ask.fromTaskId === taskId && ask.status === "pending") out.push(ask);
		}
		return out;
	}

	#openAskCount(): number {
		let n = 0;
		for (const ask of this.#asks.values()) if (ask.status === "pending") n++;
		return n;
	}

	#onAskRaised(payload: AskRaisedPayload): void {
		this.#asks.set(payload.questionId, {
			questionId: payload.questionId,
			fromTaskId: payload.fromTaskId,
			question: payload.question,
			blocking: payload.blocking,
			status: "pending",
			raisedAtMs: Date.now(),
		});
		this.#scheduleChange();
	}

	#onAskAnswered(payload: AskAnsweredPayload): void {
		const entry = this.#asks.get(payload.questionId);
		if (!entry) return;
		entry.status = "answered";
		entry.answer = payload.answer;
		entry.recipients = payload.recipients;
		this.#scheduleChange();
	}

	#onAskCancelled(payload: AskCancelledPayload): void {
		const entry = this.#asks.get(payload.questionId);
		if (!entry) return;
		entry.status = "answered";
		entry.answer = entry.answer ?? "(no answer)";
		this.#scheduleChange();
	}

	getLifetimeStats(): SubagentLifetimeStats {
		return {
			totalLaunched: this.#totalLaunched,
			totalCompleted: this.#totalCompleted,
			totalFailed: this.#totalFailed,
			totalAborted: this.#totalAborted,
			totalTokens: this.#totalTokens,
			totalCost: this.#totalCost,
			avgTokensPerSubtask: this.#totalLaunched > 0 ? Math.round(this.#totalTokens / this.#totalLaunched) : 0,
			cacheHitRate: this.#totalCacheEligibleInput > 0 ? this.#totalCacheRead / this.#totalCacheEligibleInput : 0,
			byAgentType: new Map(Array.from(this.#byAgentType.entries(), ([agent, stats]) => [agent, { ...stats }])),
		};
	}

	/** Snapshot of every non-terminal agent currently tracked. Used by viewers to hydrate on mount. */
	getActiveAgents(): AgentProgress[] {
		return Array.from(this.#activeAgents.values(), agent => structuredClone(agent));
	}

	getActivityForSession(sessionId: string): AgentProgress | undefined {
		const normalized = this.#normalizeSessionId(sessionId);
		if (!normalized) {
			return undefined;
		}
		const key = this.#sessionKeys.get(normalized);
		return key ? this.#activeAgents.get(key) : undefined;
	}

	dispose(): void {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		if (this.#notifyTimer) {
			clearTimeout(this.#notifyTimer);
			this.#notifyTimer = undefined;
		}
		this.#unsubscribe();
		for (const unsub of this.#unsubscribeAsk) unsub();
		this.#unsubscribeAsk = [];
	}

	#onProgress(payload: SubagentProgressPayload): void {
		const progress = structuredClone(payload.progress);
		const signature = this.#progressSignature(progress);
		const previousKey = this.#activeKeysBySignature.get(signature);
		const key = this.#resolveProgressKey(progress, previousKey);
		const previous = previousKey ? this.#activeAgents.get(previousKey) : undefined;

		if (previousKey && previousKey !== key) {
			this.#migrateIdentity(previousKey, key);
		}
		this.#activeKeysBySignature.set(signature, key);
		if (progress.status !== "pending") {
			this.#markLaunched(key);
		}

		if (TERMINAL_STATUSES.has(progress.status)) {
			this.#activeAgents.delete(key);
			this.#deleteSessionKey(previous?.sessionId, previousKey ?? key);
			this.#deleteSessionKey(progress.sessionId, key);
		} else {
			this.#activeAgents.set(key, progress);
			this.#deleteSessionKey(previous?.sessionId, previousKey ?? key);
			this.#setSessionKey(progress.sessionId, key);
		}

		this.#scheduleChange();
	}

	#migrateIdentity(previousKey: string, nextKey: string): void {
		const previous = this.#activeAgents.get(previousKey);
		if (previous) {
			this.#activeAgents.delete(previousKey);
			this.#activeAgents.set(nextKey, previous);
		}
		if (this.#launchedKeys.delete(previousKey)) {
			this.#launchedKeys.add(nextKey);
		}
		if (this.#completedKeys.delete(previousKey)) {
			this.#completedKeys.add(nextKey);
		}
		for (const [sessionId, key] of this.#sessionKeys.entries()) {
			if (key === previousKey) {
				this.#sessionKeys.set(sessionId, nextKey);
			}
		}
	}

	#progressSignature(progress: AgentProgress): string {
		return [progress.agent, String(progress.index), progress.id, progress.task, progress.assignment ?? ""].join("::");
	}

	#resultSignature(result: SingleResult): string {
		return [
			result.agent,
			String(result.index),
			result.id,
			result.task,
			result.assignment ?? "",
			result.outcome,
			result.textPreview ?? "",
		].join("::");
	}

	#resolveProgressKey(progress: AgentProgress, existingKey?: string): string {
		return (
			this.#normalizeSessionId(progress.sessionId) ??
			progress.transcriptPath ??
			existingKey ??
			this.#progressSignature(progress)
		);
	}

	#resolveResultKey(result: SingleResult, existingKey?: string): string {
		return (
			this.#normalizeSessionId(result.sessionId) ??
			result.transcriptUri ??
			existingKey ??
			this.#resultSignature(result)
		);
	}

	#normalizeSessionId(sessionId: string | undefined): string | undefined {
		if (!sessionId || sessionId === "pending") {
			return undefined;
		}
		return sessionId;
	}

	#setSessionKey(sessionId: string | undefined, key: string): void {
		const normalized = this.#normalizeSessionId(sessionId);
		if (!normalized) {
			return;
		}
		this.#sessionKeys.set(normalized, key);
	}

	#deleteSessionKey(sessionId: string | undefined, key: string): void {
		const normalized = this.#normalizeSessionId(sessionId);
		if (!normalized) {
			return;
		}
		if (this.#sessionKeys.get(normalized) === key) {
			this.#sessionKeys.delete(normalized);
		}
	}

	#markLaunched(key: string): void {
		if (this.#launchedKeys.has(key)) {
			return;
		}
		this.#launchedKeys.add(key);
		this.#totalLaunched += 1;
	}

	#selectMostActiveAgent(activeAgents: AgentProgress[]): AgentProgress | undefined {
		return activeAgents
			.slice()
			.sort((left, right) => {
				const leftHasTool = left.currentTool ? 1 : 0;
				const rightHasTool = right.currentTool ? 1 : 0;
				if (leftHasTool !== rightHasTool) {
					return rightHasTool - leftHasTool;
				}
				const startDelta = (right.currentToolStartMs ?? 0) - (left.currentToolStartMs ?? 0);
				if (startDelta !== 0) {
					return startDelta;
				}
				const toolDelta = right.toolCount - left.toolCount;
				if (toolDelta !== 0) {
					return toolDelta;
				}
				return right.durationMs - left.durationMs;
			})
			.at(0);
	}

	#scheduleChange(): void {
		if (this.#disposed || this.#notifyTimer) {
			return;
		}
		this.#notifyTimer = setTimeout(() => {
			this.#notifyTimer = undefined;
			if (!this.#disposed) {
				this.#onChange();
			}
		}, CHANGE_DEBOUNCE_MS);
	}
}
