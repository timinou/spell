import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { validateLoopPrerequisites } from "../config/loop-prerequisites";
import type { EventBus } from "../utils/event-bus";
import { type ChildCompletionSignal, type GateDecision, LOOP_STATES, type LoopEvent } from "./contracts";
import { LoopDashboardBridge } from "./dashboard-bridge";
import { LoopDomainRegistry } from "./domains/registry";
import { RealClock } from "./gates/clock";
import { FindingDedup } from "./gates/dedup";
import { GateEvaluator } from "./gates/evaluator";
import { ArtifactGateExecutor, CommandGateExecutor, HumanGateExecutor, LlmReviewGateExecutor } from "./gates/executors";
import type { LoopReviewer } from "./gates/types";
import { ensureCleanGitTree } from "./git/dirty-check";
import { type DriftSnapshot, detectSpecDrift, snapshotSpecFiles } from "./git/drift";
import { createLoopWorktree, removeLoopWorktree } from "./git/worktree";
import { LoopKernel } from "./kernel";
import { type IterationRunOptions, type LoopRoleResponder, PhaseCoordinator } from "./orchestration/phase-coordinator";
import { LlmSwitcher, type LoopRoleResolver } from "./orchestration/switcher";
import { saveLoopState } from "./persistence/checkpoint";
import { appendLoopEvent } from "./persistence/event-log";
import { syncLoopOrgItem } from "./persistence/org-sync";
import { restoreLoopSnapshots } from "./persistence/session-hooks";
import { applyChildCompletionPolicy } from "./recursion/completion-handler";
import { LoopDag } from "./recursion/dag";
import { ChildSpawner } from "./recursion/spawner";
import { checkBudget } from "./safeguards/budget";
import { collectKillTree } from "./safeguards/kill-switch";
import { detectRunaway } from "./safeguards/runaway";
import type {
	LoopAdvanceResult,
	LoopCommandResult,
	LoopListEntry,
	LoopPendingHumanGate,
	LoopRetryPolicy,
	LoopSnapshot,
	StartLoopOptions,
} from "./types";

interface PendingLoopEvent {
	event: LoopEvent;
	snapshot: LoopSnapshot;
}

export interface LoopManagerSettings {
	getModelRole(role: string): string | undefined;
	get?(path: string): unknown;
	set?(path: string, value: unknown): void;
}

interface LoopManagerOptions {
	cwd: string;
	settings: LoopManagerSettings;
	roleResolver?: LoopRoleResolver;
	reviewer?: LoopReviewer;
	eventBus?: EventBus;
	concurrencyLimit?: number;
}

const DEFAULT_CHILD_POLICY: LoopRetryPolicy = { policy: "retry", retries: 2 };
const WORKTREE_BASE = ".local/!tracks/worktrees";

export class LoopManager {
	readonly #cwd: string;
	readonly #settings: LoopManagerSettings;
	readonly #eventBus?: EventBus;
	readonly #kernel: LoopKernel;
	readonly #dag = new LoopDag();
	readonly #spawner: ChildSpawner;
	readonly #domainRegistry = new LoopDomainRegistry();
	readonly #humanExecutor: HumanGateExecutor;
	readonly #dedup = new FindingDedup();
	readonly #phaseCoordinator = new PhaseCoordinator();
	readonly #switcher = new LlmSwitcher();
	readonly #pendingEvents: PendingLoopEvent[] = [];
	readonly #driftSnapshots = new Map<string, DriftSnapshot>();
	readonly #reviewer?: LoopReviewer;
	readonly #roleResolver?: LoopRoleResolver;
	readonly #evaluator: GateEvaluator;
	readonly #dashboardBridge: LoopDashboardBridge;
	#restored = false;

	constructor(options: LoopManagerOptions) {
		this.#cwd = options.cwd;
		this.#settings = options.settings;
		this.#eventBus = options.eventBus;
		this.#reviewer = options.reviewer;
		this.#roleResolver = options.roleResolver;
		this.#spawner = new ChildSpawner(this.#dag, 3);
		this.#humanExecutor = new HumanGateExecutor(new RealClock(), {
			getAutoApproveTimeoutMs: () => {
				const val = this.#settings.get?.("loop.autoApproveTimeoutMs");
				return typeof val === "number" ? val : undefined;
			},
			getAutoApproveEnabled: () => {
				const val = this.#settings.get?.("loop.autoApproveEnabled");
				return typeof val === "boolean" ? val : undefined;
			},
		});
		this.#kernel = new LoopKernel({
			concurrencyLimit: options.concurrencyLimit,
			onEvent: (event, snapshot) => {
				this.#pendingEvents.push({ event, snapshot });
			},
		});
		this.#evaluator = new GateEvaluator({
			executors: {
				command: new CommandGateExecutor(),
				artifact: new ArtifactGateExecutor(),
				human: this.#humanExecutor,
				...(this.#reviewer ? { "llm-review": new LlmReviewGateExecutor(this.#reviewer) } : {}),
			},
		});
		this.#dashboardBridge = new LoopDashboardBridge(this, this.#eventBus);
	}

	async restoreFromDisk(): Promise<LoopSnapshot[]> {
		if (this.#restored) {
			return this.listSnapshots();
		}
		this.#restored = true;
		const restored = await restoreLoopSnapshots(this.#cwd);
		for (const loop of restored) {
			try {
				this.#kernel.restore(loop);
			} catch (error) {
				logger.warn("Skipping duplicate restored loop", { loopId: loop.id, error: String(error) });
			}
		}
		return restored;
	}

	async start(options: StartLoopOptions): Promise<LoopSnapshot> {
		await this.restoreFromDisk();
		const cleanTree = await ensureCleanGitTree(this.#cwd);
		// Detect git availability: ensureCleanGitTree returns ok:true with message when git is unavailable
		const gitAvailable = cleanTree.ok && !cleanTree.message;
		if (!cleanTree.ok) {
			throw new Error(cleanTree.message ?? "Repository has uncommitted changes");
		}
		if (!gitAvailable) {
			logger.warn("Git repository unavailable; git features disabled for this loop", { cwd: this.#cwd });
		}
		const prerequisites = validateLoopPrerequisites(this.#settings);
		const domains = (options.domains ?? ["code", "test"]).map(name => {
			const domain = this.#domainRegistry.get(name);
			if (!domain) {
				throw new Error(`Unknown loop domain: ${name}`);
			}
			return domain;
		});
		const gateConfigs = [...domains.flatMap(domain => domain.defaultGates), ...(options.gates ?? [])];
		const snapshot = this.#kernel.start({
			...options,
			domains: domains.map(domain => domain.name),
			gates: gateConfigs,
		});
		// Set gitAvailable on the snapshot
		this.#kernel.updateLoop(
			snapshot.id,
			loop => {
				loop.gitAvailable = gitAvailable;
			},
			"loop.git_status",
			{ gitAvailable },
		);
		// Git-dependent operations: skip when git unavailable
		if (gitAvailable) {
			if (options.specPaths && options.specPaths.length > 0) {
				this.#driftSnapshots.set(snapshot.id, await snapshotSpecFiles(options.specPaths));
			}
			// Worktree creation (opt-in)
			if (options.useWorktree) {
				try {
					const targetDir = path.join(this.#cwd, WORKTREE_BASE, snapshot.id);
					const wt = await createLoopWorktree(this.#cwd, snapshot.id, targetDir);
					this.#kernel.updateLoop(
						snapshot.id,
						loop => {
							loop.worktreePath = wt.path;
						},
						"loop.worktree_created",
						{ branch: wt.branch, path: wt.path },
					);
				} catch (err) {
					logger.error("Failed to create loop worktree", { loopId: snapshot.id, error: String(err) });
				}
			}
		} else if (options.useWorktree) {
			logger.warn("Worktree requested but git unavailable; skipping", { loopId: snapshot.id });
		}
		this.#kernel.setReviewModelConfigured(snapshot.id, prerequisites.ok);
		await this.#flushPendingEvents();
		// Register dashboard panel in shell sidebar
		this.#dashboardBridge.registerPanel(snapshot.id, snapshot.name);
		return this.#kernel.getState(snapshot.id);
	}

	async pause(loopId: string, reason?: string): Promise<LoopSnapshot> {
		const snapshot = this.#kernel.pause(loopId, reason);
		await this.#flushPendingEvents();
		return snapshot;
	}

	async resume(loopId: string): Promise<LoopSnapshot> {
		const snapshot = this.#kernel.resume(loopId);
		await this.#flushPendingEvents();
		return snapshot;
	}

	async markDone(
		loopId: string,
		options: {
			summary?: string;
			changedFiles?: string[];
			findings?: string[];
			forceValidate?: boolean;
			taskContent?: string;
		} = {},
	): Promise<LoopSnapshot> {
		const snapshot = this.#kernel.done(loopId, options);
		// Clean up worktree on terminal state
		if (snapshot.state === LOOP_STATES.complete) {
			await this.#cleanupWorktree(loopId);
			this.#dashboardBridge.unregisterPanel(loopId);
		}
		await this.#flushPendingEvents();
		return snapshot;
	}

	async kill(loopId: string): Promise<LoopSnapshot[]> {
		const all = this.listSnapshots();
		const killedIds = collectKillTree(loopId, all);
		const killed: LoopSnapshot[] = [];
		for (const id of killedIds) {
			await this.#cleanupWorktree(id);
			const snapshot = this.#kernel.kill(id);
			killed.push(snapshot);
			this.#dashboardBridge.unregisterPanel(id);
		}
		await this.#flushPendingEvents();
		return killed;
	}

	async runIteration(
		loopId: string,
		responder: LoopRoleResponder,
		iterationOptions?: IterationRunOptions,
	): Promise<LoopAdvanceResult> {
		let snapshot = this.#kernel.getState(loopId);
		if (snapshot.state === LOOP_STATES.paused) {
			throw new Error(`Loop ${loopId} is paused`);
		}
		if (snapshot.state === LOOP_STATES.planning) {
			this.#resolveSwitch("plan");
			snapshot = this.#kernel.done(loopId);
		}
		const run = await this.#phaseCoordinator.runIteration(snapshot, responder, iterationOptions);
		this.#resolveSwitch("review");
		this.#kernel.updateLoop(
			loopId,
			loop => {
				loop.handoffs.push(...run.handoffs);
				loop.changedFiles = [...run.changedFiles];
				loop.openFindings = [...run.findings];
				loop.currentRole = "plan";
			},
			"loop.handoffs_recorded",
			{ handoffCount: run.handoffs.length },
		);
		snapshot = this.#kernel.done(loopId, {
			summary: run.reviewSummary,
			changedFiles: run.changedFiles,
			findings: run.findings,
		});
		const gateDecisions = await this.#evaluateLoopGates(snapshot);
		if (snapshot.state === LOOP_STATES.reflecting) {
			this.#resolveSwitch("plan");
		}
		if (snapshot.state === LOOP_STATES.validating && gateDecisions.every(decision => decision.outcome === "pass")) {
			snapshot = this.#kernel.done(loopId);
		}
		await this.#checkSafeguards(snapshot);
		await this.#flushPendingEvents();
		return {
			snapshot: this.#kernel.getState(loopId),
			handoffs: run.handoffs,
			gateDecisions,
			childCompletions: [],
		};
	}

	async approveGate(loopId: string, gateId: string): Promise<void> {
		this.#humanExecutor.approve(loopId, gateId);
	}

	async rejectGate(loopId: string, gateId: string): Promise<void> {
		this.#humanExecutor.reject(loopId, gateId);
	}

	setAutoApprove(loopId: string, gateId: string, enabled: boolean): void {
		this.#humanExecutor.setAutoApprove(loopId, gateId, enabled);
		// Persist the toggle to settings if available
		this.#settings.set?.("loop.autoApproveEnabled", enabled);
	}

	listPendingHumanGates(loopId?: string): LoopPendingHumanGate[] {
		return this.#humanExecutor.listPending(loopId);
	}

	listLoops(): LoopListEntry[] {
		return this.#kernel.listLoops();
	}

	listSnapshots(): LoopSnapshot[] {
		return this.#kernel.listLoops().map(entry => this.#kernel.getState(entry.id));
	}

	getLoop(loopId: string): LoopSnapshot {
		return this.#kernel.getState(loopId);
	}

	async spawnChild(parentLoopId: string, options: StartLoopOptions): Promise<LoopSnapshot> {
		const parent = this.#kernel.getState(parentLoopId);
		const prepared = this.#spawner.prepareChild(parent, options);
		if (!prepared.allowed || !prepared.options) {
			throw new Error(prepared.reason ?? "Child loop spawn rejected");
		}
		const child = await this.start(prepared.options);
		const policy = options.failurePolicy ?? DEFAULT_CHILD_POLICY;
		this.#spawner.registerChild(parent, child.id, options.requiredChild ?? true, policy);
		this.#kernel.updateLoop(
			parentLoopId,
			loop => {
				loop.childLoopIds.push(child.id);
				loop.pendingChildLoopIds.push(child.id);
				if (options.requiredChild ?? true) {
					loop.requiredChildLoopIds.push(child.id);
				}
			},
			"loop.child_spawned",
			{ childLoopId: child.id },
		);
		await this.#flushPendingEvents();
		return child;
	}

	async completeChild(signal: ChildCompletionSignal): Promise<void> {
		const edge = this.#dag.getEdge(signal.parentLoopId, signal.childLoopId);
		if (!edge) {
			throw new Error(`Unknown child edge ${signal.parentLoopId} -> ${signal.childLoopId}`);
		}
		const action = applyChildCompletionPolicy(signal, edge.failurePolicy, edge.attempts);
		this.#kernel.updateLoop(
			signal.parentLoopId,
			loop => {
				loop.pendingChildLoopIds = loop.pendingChildLoopIds.filter(id => id !== signal.childLoopId);
				if (action.action === "skip") {
					loop.statusReason = action.reason;
				}
				if (action.action === "block" || action.action === "escalate") {
					loop.state = LOOP_STATES.paused;
					loop.statusReason = action.reason;
				}
			},
			"loop.child_completed",
			{ childLoopId: signal.childLoopId, action: action.action },
		);
		await this.#flushPendingEvents();
	}

	status(loopId?: string): string {
		const loops = loopId ? [this.getLoop(loopId)] : this.listSnapshots();
		if (loops.length === 0) return "No loops registered.";
		return loops
			.map(loop => {
				const pending = this.listPendingHumanGates(loop.id).length;
				return `${loop.name} (${loop.id}) state=${loop.state} iteration=${loop.iteration}/${loop.maxIterations} elapsed=${loop.budgetStatus.elapsedMs}ms pendingHumanGates=${pending}`;
			})
			.join("\n");
	}

	async handleCommand(command: string, args: string[]): Promise<LoopCommandResult> {
		switch (command) {
			case "start": {
				const name = args.join(" ").trim();
				if (!name) return { ok: false, message: "Usage: /loop start <name>" };
				const loop = await this.start({ name });
				return { ok: true, message: `Started loop ${loop.id}`, loop };
			}
			case "pause": {
				const loopId = args[0];
				if (!loopId) return { ok: false, message: "Usage: /loop pause <id>" };
				const loop = await this.pause(loopId);
				return { ok: true, message: `Paused loop ${loop.id}`, loop };
			}
			case "resume": {
				const loopId = args[0];
				if (!loopId) return { ok: false, message: "Usage: /loop resume <id>" };
				const loop = await this.resume(loopId);
				return { ok: true, message: `Resumed loop ${loop.id}`, loop };
			}
			case "status":
				return { ok: true, message: this.status(args[0]) };
			case "list":
				return { ok: true, message: this.status() };
			case "kill": {
				const loopId = args[0];
				if (!loopId) return { ok: false, message: "Usage: /loop kill <id>" };
				const killed = await this.kill(loopId);
				return { ok: true, message: `Killed ${killed.length} loop(s) rooted at ${loopId}` };
			}
			case "approve": {
				const [loopId, gateId] = args;
				if (!loopId || !gateId) return { ok: false, message: "Usage: /loop approve <loopId> <gateId>" };
				await this.approveGate(loopId, gateId);
				return { ok: true, message: `Approved gate ${gateId}` };
			}
			case "reject": {
				const [loopId, gateId] = args;
				if (!loopId || !gateId) return { ok: false, message: "Usage: /loop reject <loopId> <gateId>" };
				await this.rejectGate(loopId, gateId);
				return { ok: true, message: `Rejected gate ${gateId}` };
			}
			default:
				return { ok: false, message: "Usage: /loop <start|pause|resume|status|list|kill|approve|reject>" };
		}
	}

	async #evaluateLoopGates(loop: LoopSnapshot): Promise<GateDecision[]> {
		const event = { iteration: loop.iteration, state: loop.state };
		const decisions = await this.#evaluator.evaluate(loop, event, {
			cwd: this.#cwd,
			attemptNumber: 1,
			evidence: [],
		});
		for (const decision of decisions) {
			const dedup = this.#dedup.evaluate(decision.gateId, decision.evidence);
			const nextDecision = dedup.repeated
				? { ...decision, outcome: "escalated" as const, previousFindings: dedup.normalizedFindings }
				: decision;
			this.#kernel.updateLoop(
				loop.id,
				current => {
					current.gateResults.push(nextDecision);
					current.pendingGates = current.pendingGates.filter(id => id !== nextDecision.gateId);
				},
				"loop.gate_decision",
				{ gateId: nextDecision.gateId, outcome: nextDecision.outcome },
			);
		}
		return decisions;
	}

	async #checkSafeguards(loop: LoopSnapshot): Promise<void> {
		const latest = this.#kernel.getState(loop.id);
		const budget = checkBudget(latest, Date.now());
		if (budget.exceeded) {
			this.#kernel.pause(loop.id, budget.reason);
		}
		const runaway = detectRunaway(latest, latest.lastProgressHash);
		if (runaway.runaway) {
			this.#kernel.pause(loop.id, `Runaway detected after ${runaway.idleIterations} idle iterations`);
		}
		this.#kernel.updateLoop(
			loop.id,
			current => {
				current.budgetStatus.idleIterations = runaway.idleIterations;
			},
			"loop.safeguards_checked",
			{ idleIterations: runaway.idleIterations },
		);
		// Drift detection only when git is available
		if (latest.gitAvailable) {
			const driftSnapshot = this.#driftSnapshots.get(loop.id);
			if (driftSnapshot && latest.state === LOOP_STATES.reflecting) {
				const drifted = await detectSpecDrift(driftSnapshot);
				if (drifted.length > 0) {
					this.#kernel.pause(loop.id, `Spec drift detected: ${drifted.join(", ")}`);
				}
			}
		}
	}

	async #cleanupWorktree(loopId: string): Promise<void> {
		try {
			const snapshot = this.#kernel.getState(loopId);
			if (snapshot.worktreePath) {
				await removeLoopWorktree(this.#cwd, snapshot.worktreePath);
				logger.debug("Removed loop worktree", { loopId, path: snapshot.worktreePath });
			}
		} catch (err) {
			logger.warn("Failed to remove loop worktree", { loopId, error: String(err) });
		}
	}

	async #flushPendingEvents(): Promise<void> {
		while (this.#pendingEvents.length > 0) {
			const next = this.#pendingEvents.shift();
			if (!next) continue;
			await appendLoopEvent(this.#cwd, next.event, next.snapshot);
			await syncLoopOrgItem(this.#cwd, next.snapshot);
			await saveLoopState(this.#cwd, next.snapshot);
			this.#eventBus?.emit(this.#channelFor(next.event), next.event);
		}
	}

	#channelFor(event: LoopEvent): string {
		if (event.type.includes("gate")) return `loop:${event.loopId}:gate`;
		if (event.type.includes("iteration")) return `loop:${event.loopId}:iteration`;
		return `loop:${event.loopId}:state`;
	}

	#resolveSwitch(role: "plan" | "review"): void {
		if (!this.#roleResolver) return;
		this.#switcher.resolve(role, this.#roleResolver);
	}
}
