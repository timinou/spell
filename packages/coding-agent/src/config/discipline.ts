/**
 * The unified `discipline` primitive (FEAT-816).
 *
 * A *discipline* is a named protocol with three parts:
 *   1. a TRIGGER  (`on`)     — when it activates
 *   2. an INJECT  (`inject`) — guidance entering context, and its cadence
 *   3. a VERIFY   (`verify`) — the loop-closer gate (optional)
 *
 * It is the single shape that `mode` (workflow role), `policy` (layer gate),
 * and a tool's `<discipline>` block (e.g. Mock-critique) all normalize into.
 * Those three were parallel implementations of one need — "a named protocol
 * that activates on a trigger, injects guidance, optionally closes with a
 * gate". This module is the convergence point; `mode`/`policy` remain as
 * thin desugaring aliases (see {@link modeToDiscipline}, {@link policyToDiscipline}).
 *
 * The trigger taxonomy is a subset of NexAU-AHE's six activation modes
 * (manual · actor-default · trigger-word · task-classifier · goal-bound ·
 * supervisor-forced). `auto` ≙ task-classifier; the remaining two are FUP.
 */

import type { ModeConfig, ModeConfigSections } from "../capability/mode";
import type { TaskPolicy, TaskVerify } from "./task-policies";

// Trigger
// =============================================================================

/**
 * What causes a discipline to activate.
 * - `manual`: user invokes it (`/slash` command or explicit selection) — roles
 * - `tool`:   the named tool produces a result — tool-disciplines (inject-once)
 * - `layer`:  a task/org item with the matching `layer` is created — layer policies
 * - `auto`:   a task-classifier decides the discipline matches the current work
 */
export type DisciplineTrigger =
	| { kind: "manual" }
	| { kind: "tool"; tool: string }
	| { kind: "layer"; layer: string }
	| { kind: "auto" };

// Inject
// =============================================================================

/**
 * Cadence of context injection.
 * - `carry`: re-injected every turn while active (keeps a role salient)
 * - `once`:  injected on first activation only (tool-disciplines; lighter)
 */
export type DisciplineCadence = "carry" | "once";

/**
 * The guidance a discipline injects into context. Prose authored inline in KDL
 * (`context` / `instructions` / `focus-areas` multiline strings). Reuses the
 * existing {@link ModeConfigSections} shape so the role-injection path is shared.
 */
export interface DisciplineInject {
	cadence: DisciplineCadence;
	sections: ModeConfigSections;
}

// Verify (loop-closer)
// =============================================================================

/**
 * A discipline's verify gate — the closing half of a sub-loop. Identical to the
 * shared {@link TaskVerify} vocab (`commit|artifact|cmd|review|swarm`); the
 * `swarm` gate fans out N parallel reviewers over the wave diff and is
 * satisfiable-by-existing-review (if the diff was already audited this
 * activation, the gate clears without re-dispatching — validated against session
 * logs: 41% of swarm-using waves self-review).
 */
export type DisciplineVerify = TaskVerify;

// Guard (session-yield predicate)
// =============================================================================

/**
 * A session-yield predicate — evaluated at the agent's stopping point, before
 * the turn is released. Sibling to the node-scoped {@link DisciplineVerify}
 * gate: `verify` closes a todo/task sub-loop; `guard` closes the root session's
 * loop. Evaluated by the shared yield-evaluation path that replaced the old
 * hard-coded todo-reminder system.
 *
 * - `open-work`: one or more todos are still pending/in_progress → re-prompt
 *   before yielding (the generic form of the old "incomplete todo" reminder).
 *
 * Extensible: add a literal here and a predicate in the yield evaluator.
 */
export type YieldGuard = "open-work";

/**
 * Result of evaluating one discipline's yield gate. Emitted on the
 * {@link AgentSessionEvent} `yield_reminder` event and persisted to the session
 * JSONL so activations and failed verifications are queryable after the fact.
 * `passed: false` outcomes describe "what happened instead".
 */
export interface DisciplineGateOutcome {
	discipline: string;
	passed: boolean;
	/** Which gate produced this outcome. */
	gate: "open-work" | "verify-cmd" | "verify-review" | "guard";
	/** One-line reason; on failure, why the gate was not satisfied. */
	reason?: string;
	/** `open-work`: number of pending/in_progress todos. */
	incompleteCount?: number;
	/** `verify-cmd`: captured exit code + stderr tail. */
	exitCode?: number;
	stderr?: string;
	/** `verify-review`: the judge's reason. */
	reasoning?: string;
}

export type DisciplineGateKind = DisciplineGateOutcome["gate"];

/** Per-session runtime stats for one always-on discipline. */
export interface DisciplineRuntimeStat {
	name: string;
	description?: string;
	origin: Discipline["origin"];
	on: DisciplineTrigger["kind"];
	guard?: YieldGuard;
	verifyCmd: boolean;
	verifyReview: boolean;
	armedAt: string;
	activationCount: number;
	lastFiredAt?: string;
	lastOutcome?: DisciplineGateOutcome;
	gateBreakdown: Partial<Record<DisciplineGateKind, number>>;
}

/** Structured session JSONL payload for discipline observability metadata. */
export interface DisciplineEventData {
	phase: "arm" | "yield-reminder";
	timestamp: string;
	disciplines: DisciplineRuntimeStat[];
	outcomes?: DisciplineGateOutcome[];
	attempt?: number;
	maxAttempts?: number;
}

// Discipline
// =============================================================================

/** Optional tool constraints a discipline imposes while active. */
export interface DisciplineTools {
	allow?: string[];
	deny?: string[];
}

/**
 * The normalized discipline. Every `mode`, `policy`, and tool `<discipline>`
 * block resolves to exactly this shape.
 */
export interface Discipline {
	name: string;
	description?: string;
	/** `/slash` + titlebar label for manually-triggered disciplines (roles). */
	command?: string;
	on: DisciplineTrigger;
	inject?: DisciplineInject;
	verify?: DisciplineVerify;
	/** Session-yield predicate ({@link YieldGuard}); closes the root loop at yield. */
	guard?: YieldGuard;
	tools?: DisciplineTools;
	readOnly?: boolean;
	/** Where this discipline came from — for diagnostics and dedup. */
	origin: "discipline" | "mode" | "policy" | "tool";
}

// Normalizers (desugaring)
// =============================================================================

/**
 * Desugar a workflow `mode` (role) into a discipline.
 * Roles are manually triggered and carry their prose every turn unless the
 * author set `context-policy "fresh"` (→ `once`).
 */
export function modeToDiscipline(mode: ModeConfig): Discipline {
	const fm = mode.frontmatter;
	const cadence: DisciplineCadence = fm.contextPolicy === "fresh" ? "once" : "carry";
	const discipline: Discipline = {
		name: mode.name,
		description: fm.description,
		command: fm.command,
		on: { kind: "manual" },
		inject: { cadence, sections: mode.sections },
		origin: "mode",
	};
	if (fm.readOnly !== undefined) discipline.readOnly = fm.readOnly;
	if (fm.tools) discipline.tools = fm.tools;
	return discipline;
}

/**
 * Desugar a layer `policy` into a discipline.
 * Layer policies are triggered by layer match, inject their `inject` text once
 * (advisory), and carry their verify gate.
 */
export function policyToDiscipline(policy: TaskPolicy): Discipline {
	const discipline: Discipline = {
		name: policy.name,
		description: policy.description,
		on: { kind: "layer", layer: policy.match.layer },
		origin: "policy",
	};
	if (policy.inject?.trim()) {
		discipline.inject = {
			cadence: "once",
			sections: { context: policy.inject.trim(), custom: {} },
		};
	}
	if (hasVerify(policy.verify)) discipline.verify = { ...policy.verify };
	return discipline;
}

/**
 * Build a tool-discipline (e.g. Mock-critique) from a tool name + inline
 * `<discipline>` prose. Triggered by the tool producing a result; injected
 * once per session (the prose is a post-result protocol, not a per-call hint).
 */
export function toolDiscipline(name: string, tool: string, sections: ModeConfigSections): Discipline {
	return {
		name,
		on: { kind: "tool", tool },
		inject: { cadence: "once", sections },
		origin: "tool",
	};
}

// Helpers
// =============================================================================

/** True when a verify gate carries at least one active requirement. */
export function hasVerify(verify: TaskVerify | undefined): boolean {
	if (!verify) return false;
	return (
		verify.commit !== undefined ||
		verify.artifact !== undefined ||
		verify.cmd !== undefined ||
		verify.review !== undefined ||
		verify.swarm !== undefined
	);
}

/**
 * Ordered prose sections of an inject, flattened to a list. Covers every
 * {@link ModeConfigSections} prose field — not just context/instructions/focus —
 * so a role/discipline whose guidance lives in examples/phase/custom sections
 * is not silently dropped.
 */
function injectSectionList(inject: DisciplineInject | undefined): string[] {
	if (!inject) return [];
	const s = inject.sections;
	const ordered = [
		s.context,
		s.instructions,
		s.focusAreas,
		s.planPhase,
		s.codePhase,
		s.reviewPhase,
		s.examples,
		...Object.values(s.custom ?? {}),
	];
	return ordered.map(x => x?.trim()).filter((x): x is string => !!x);
}

/** True when the inject carries any non-empty prose section. */
export function hasInject(inject: DisciplineInject | undefined): boolean {
	return injectSectionList(inject).length > 0;
}

/** Flatten an inject's prose sections into one body string, in section order. */
export function injectBody(inject: DisciplineInject | undefined): string {
	return injectSectionList(inject).join("\n\n");
}

/**
 * Build the tool→discipline lookup map for a discipline set: only `on tool`
 * disciplines that carry inject prose are eligible for once-per-session
 * post-result injection. (Shared by the session wiring and its tests.)
 */
export function toolDisciplineMap(disciplines: Discipline[]): Map<string, Discipline> {
	const map = new Map<string, Discipline>();
	for (const d of disciplines) {
		if (d.on.kind === "tool" && hasInject(d.inject)) map.set(d.on.tool, d);
	}
	return map;
}
