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
 * A discipline's verify gate — the closing half of a sub-loop. Extends the
 * shared {@link TaskVerify} vocab (`commit|artifact|cmd|review`) with `swarm`:
 * fan out N parallel reviewers over the wave diff and block until they pass.
 *
 * `swarm` is satisfiable-by-existing-review: if the wave's diff was already
 * audited this activation, the gate clears without re-dispatching (validated
 * against session logs — 41% of swarm-using waves self-review).
 */
export interface DisciplineVerify extends TaskVerify {
	swarm?: {
		/** Number of parallel reviewer agents to fan out. */
		count: number;
		/** Optional per-swarm acceptance criteria handed to each reviewer. */
		criteria?: string;
	};
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
export function hasVerify(verify: DisciplineVerify | TaskVerify | undefined): boolean {
	if (!verify) return false;
	return (
		verify.commit !== undefined ||
		verify.artifact !== undefined ||
		verify.cmd !== undefined ||
		verify.review !== undefined ||
		("swarm" in verify && verify.swarm !== undefined)
	);
}

/** True when the inject carries any non-empty prose section. */
export function hasInject(inject: DisciplineInject | undefined): boolean {
	if (!inject) return false;
	const { context, instructions, focusAreas } = inject.sections;
	return !!(context?.trim() || instructions?.trim() || focusAreas?.trim());
}
