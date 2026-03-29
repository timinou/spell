import { Type } from "@sinclair/typebox";

export const LOOP_STATES = {
	idle: "idle",
	planning: "planning",
	iterating: "iterating",
	reflecting: "reflecting",
	validating: "validating",
	complete: "complete",
	failed: "failed",
	paused: "paused",
	cancelled: "cancelled",
	killed: "killed",
} as const;

export type LoopState = (typeof LOOP_STATES)[keyof typeof LOOP_STATES];

export const LoopStateSchema = Type.Union([
	Type.Literal(LOOP_STATES.idle),
	Type.Literal(LOOP_STATES.planning),
	Type.Literal(LOOP_STATES.iterating),
	Type.Literal(LOOP_STATES.reflecting),
	Type.Literal(LOOP_STATES.validating),
	Type.Literal(LOOP_STATES.complete),
	Type.Literal(LOOP_STATES.failed),
	Type.Literal(LOOP_STATES.paused),
	Type.Literal(LOOP_STATES.cancelled),
	Type.Literal(LOOP_STATES.killed),
]);

export const GATE_TRIGGERS = {
	everyIteration: "every-iteration",
	everyN: "every-n",
	onReflection: "on-reflection",
	onCompletion: "on-completion",
	onChildComplete: "on-child-complete",
} as const;

export type GateTrigger = (typeof GATE_TRIGGERS)[keyof typeof GATE_TRIGGERS];

export const GateTriggerSchema = Type.Union([
	Type.Literal(GATE_TRIGGERS.everyIteration),
	Type.Literal(GATE_TRIGGERS.everyN),
	Type.Literal(GATE_TRIGGERS.onReflection),
	Type.Literal(GATE_TRIGGERS.onCompletion),
	Type.Literal(GATE_TRIGGERS.onChildComplete),
]);

export const FAILURE_POLICIES = {
	retry: "retry",
	block: "block",
	skip: "skip",
	escalate: "escalate",
} as const;

export type FailurePolicy = (typeof FAILURE_POLICIES)[keyof typeof FAILURE_POLICIES];

export const FailurePolicySchema = Type.Union([
	Type.Literal(FAILURE_POLICIES.retry),
	Type.Literal(FAILURE_POLICIES.block),
	Type.Literal(FAILURE_POLICIES.skip),
	Type.Literal(FAILURE_POLICIES.escalate),
]);

export const GATE_TYPES = {
	command: "command",
	llmReview: "llm-review",
	artifact: "artifact",
	human: "human",
} as const;

export type GateType = (typeof GATE_TYPES)[keyof typeof GATE_TYPES];

export const GateTypeSchema = Type.Union([
	Type.Literal(GATE_TYPES.command),
	Type.Literal(GATE_TYPES.llmReview),
	Type.Literal(GATE_TYPES.artifact),
	Type.Literal(GATE_TYPES.human),
]);

export const GATE_OUTCOMES = {
	pass: "pass",
	fail: "fail",
	pending: "pending",
	escalated: "escalated",
} as const;

export type GateOutcome = (typeof GATE_OUTCOMES)[keyof typeof GATE_OUTCOMES];

export const GateOutcomeSchema = Type.Union([
	Type.Literal(GATE_OUTCOMES.pass),
	Type.Literal(GATE_OUTCOMES.fail),
	Type.Literal(GATE_OUTCOMES.pending),
	Type.Literal(GATE_OUTCOMES.escalated),
]);

export const CHILD_OUTCOMES = {
	success: "success",
	failed: "failed",
	cancelled: "cancelled",
	skipped: "skipped",
} as const;

export type ChildOutcome = (typeof CHILD_OUTCOMES)[keyof typeof CHILD_OUTCOMES];

export const ChildOutcomeSchema = Type.Union([
	Type.Literal(CHILD_OUTCOMES.success),
	Type.Literal(CHILD_OUTCOMES.failed),
	Type.Literal(CHILD_OUTCOMES.cancelled),
	Type.Literal(CHILD_OUTCOMES.skipped),
]);

export const LOOP_ROLES = {
	plan: "plan",
	code: "code",
	review: "review",
} as const;

export type LoopRole = (typeof LOOP_ROLES)[keyof typeof LOOP_ROLES];

export const LoopRoleSchema = Type.Union([
	Type.Literal(LOOP_ROLES.plan),
	Type.Literal(LOOP_ROLES.code),
	Type.Literal(LOOP_ROLES.review),
]);
