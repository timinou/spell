/**
 * Submit result tool for structured subagent output.
 *
 * Subagents must call this tool to finish and return structured JSON output.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@spell/pi-agent-core";
import { dereferenceJsonSchema, sanitizeSchemaForStrictMode } from "@spell/pi-ai/utils/schema";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ToolSession } from ".";
import { jtdToJsonSchema } from "./jtd-to-json-schema";

export interface SubmitResultDetails {
	data: unknown;
	status: "success" | "aborted";
	error?: string;
	/** Sole authority on session continuation. Omitted/false ⇒ this call resolves
	 * the session's terminal result and ends it (regardless of data vs error).
	 * true ⇒ this call is a checkpoint — appended to the session's checkpoint log,
	 * session continues — unconditionally, including when `error` is also set
	 * ("this approach failed, trying another" is a valid checkpoint). Neither
	 * `data` nor `error` overrides this in either direction — PLAN-350 S3. */
	keepGoing: boolean;
}

const ajv = new Ajv({ allErrors: true, strict: false, logger: false });

function normalizeSchema(schema: unknown): { normalized?: unknown; error?: string } {
	if (schema === undefined || schema === null) return {};
	if (typeof schema === "string") {
		try {
			return { normalized: JSON.parse(schema) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
	return { normalized: schema };
}

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
	if (!errors || errors.length === 0) return "Unknown schema validation error.";
	return errors
		.map(err => {
			const path = err.instancePath ? `${err.instancePath}: ` : "";
			return `${path}${err.message ?? "invalid"}`;
		})
		.join("; ");
}

export class SubmitResultTool implements AgentTool<TSchema, SubmitResultDetails> {
	readonly name = "submit_result";
	readonly label = "Submit Result";
	readonly description =
		"Finish the task with structured JSON output. Call ONCE at the end of the task — by default " +
		"this call ENDS THE SESSION IMMEDIATELY, and no further tool calls will be processed after it.\n\n" +
		"If you cannot complete the task, call with an error message payload (this still ends the " +
		"session unless keep_going is also set).\n\n" +
		"Only set `keep_going: true` if you have MORE work to do after this call — that makes this a " +
		"checkpoint instead of the final answer, and the session continues so you can call " +
		"submit_result again later. Checkpoints are capped; do not set keep_going speculatively or " +
		"call submit_result repeatedly without real new work in between.";
	readonly parameters: TSchema;
	strict = true;
	lenientArgValidation = true;

	readonly #validate?: ValidateFunction;
	#schemaValidationFailures = 0;

	constructor(session: ToolSession) {
		const keepGoingField = Type.Optional(
			Type.Boolean({
				description:
					"Sole control over whether this call ends the session. Omit or set false to submit your " +
					"FINAL result and end the session now (the normal case: call once, then stop). Set true " +
					"ONLY if you have MORE work to do after this call and are checkpointing intermediate " +
					"progress: the session continues and you may call submit_result again later. Do not set " +
					"true speculatively or repeatedly: checkpoints are capped per session.",
			}),
		);
		const createParameters = (dataSchema: TSchema): TSchema =>
			Type.Object(
				{
					result: Type.Union([
						Type.Object(
							{ data: dataSchema, keep_going: keepGoingField },
							{ description: "Successfully completed the task (or a checkpoint if keep_going is true)" },
						),
						Type.Object({
							error: Type.String({ description: "Error message when the task cannot be completed" }),
							keep_going: keepGoingField,
						}),
					]),
				},
				{
					additionalProperties: false,
					description: "Submit either `data` for success or `error` for failure",
				},
			) as TSchema;

		let validate: ValidateFunction | undefined;
		let dataSchema: TSchema;
		let parameters: TSchema;
		let strict = true;

		try {
			const schemaResult = normalizeSchema(session.outputSchema);
			// Convert JTD to JSON Schema if needed (auto-detected)
			const normalizedSchema =
				schemaResult.normalized !== undefined ? jtdToJsonSchema(schemaResult.normalized) : undefined;
			let schemaError = schemaResult.error;

			if (!schemaError && normalizedSchema === false) {
				schemaError = "boolean false schema rejects all outputs";
			}

			if (normalizedSchema !== undefined && normalizedSchema !== false && !schemaError) {
				try {
					validate = ajv.compile(normalizedSchema as Record<string, unknown> | boolean);
				} catch (err) {
					schemaError = err instanceof Error ? err.message : String(err);
				}
			}

			const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);
			const schemaDescription = schemaError
				? `Structured JSON output (output schema invalid; accepting unconstrained object): ${schemaError}`
				: `Structured output matching the schema:\n${schemaHint}`;
			const sanitizedSchema =
				!schemaError &&
				normalizedSchema != null &&
				typeof normalizedSchema === "object" &&
				!Array.isArray(normalizedSchema)
					? sanitizeSchemaForStrictMode(normalizedSchema as Record<string, unknown>)
					: !schemaError && normalizedSchema === true
						? {}
						: undefined;

			if (sanitizedSchema !== undefined) {
				const resolved = dereferenceJsonSchema({
					...sanitizedSchema,
					description: schemaDescription,
				});
				dataSchema = Type.Unsafe(resolved as Record<string, unknown>);
			} else {
				dataSchema = Type.Record(Type.String(), Type.Any(), {
					description: schemaError ? schemaDescription : "Structured JSON output (no schema specified)",
				});
			}
			parameters = createParameters(dataSchema);
			JSON.stringify(parameters);
			// Verify the final parameters compile with AJV (catches unresolved $ref, etc.)
			ajv.compile(parameters as Record<string, unknown>);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			dataSchema = Type.Record(Type.String(), Type.Any(), {
				description: `Structured JSON output (schema processing failed: ${errorMsg})`,
			});
			parameters = createParameters(dataSchema);
			validate = undefined;
			strict = false;
		}

		this.#validate = validate;
		this.parameters = parameters;
		this.strict = strict;
	}

	async execute(
		_toolCallId: string,
		params: Static<TSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SubmitResultDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SubmitResultDetails>> {
		const raw = params as Record<string, unknown>;
		const rawResult = raw.result;
		if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
			throw new Error("result must be an object containing either data or error");
		}

		const resultRecord = rawResult as Record<string, unknown>;
		const errorMessage = typeof resultRecord.error === "string" ? resultRecord.error : undefined;
		const data = resultRecord.data;
		// PLAN-350 S3: keep_going is the SOLE authority on continuation — omitted or
		// false means this call resolves the terminal result, regardless of whether
		// data or error is set. true means this is a checkpoint and the session
		// continues, again regardless of data vs error ("this approach failed, trying
		// another" is a valid checkpoint). Neither data nor error overrides it.
		//
		// Note: this tool does NOT itself hard-lock after a terminal call. The
		// single-assignment CAS on "the" terminal result lives at the EXECUTOR layer
		// (task/executor.ts), which is gate-verification-aware — a terminal claim can
		// be legitimately rejected (BUG-354 gate verification) and the executor then
		// deliberately re-prompts for a corrected resubmission (bounded retry count).
		// Locking here would make that legitimate retry impossible. What actually
		// prevents runaway re-calls is `haltsLoop` below: once set, the agent loop
		// (agent-loop.ts runLoop) will not schedule another model turn AT ALL unless
		// the executor itself deliberately issues a new prompt — the model cannot
		// re-invoke this tool (or any tool) on its own after a haltsLoop:true result.
		const keepGoing = resultRecord.keep_going === true;

		if (errorMessage !== undefined && data !== undefined) {
			throw new Error("result cannot contain both data and error");
		}
		if (errorMessage === undefined && data === undefined) {
			throw new Error("result must contain either data or error");
		}

		const status = errorMessage !== undefined ? "aborted" : "success";
		let schemaValidationOverridden = false;
		if (status === "success") {
			if (data === undefined || data === null) {
				throw new Error("data is required when submit_result indicates success");
			}
			if (this.#validate && !this.#validate(data)) {
				this.#schemaValidationFailures++;
				if (this.#schemaValidationFailures <= 1) {
					throw new Error(`Output does not match schema: ${formatAjvErrors(this.#validate.errors)}`);
				}
				schemaValidationOverridden = true;
			}
		}

		const responseText = !keepGoing
			? status === "aborted"
				? `Task aborted: ${errorMessage}`
				: schemaValidationOverridden
					? `Result submitted (schema validation overridden after ${this.#schemaValidationFailures} failed attempt(s))). Session ending now.`
					: "Result submitted. Session ending now — no further tool calls will be processed."
			: status === "aborted"
				? `Checkpoint recorded (attempt failed: ${errorMessage}). Session continues — keep working.`
				: "Checkpoint recorded. Session continues — keep working, then call submit_result again (omit keep_going, or set it false) when done.";

		return {
			content: [{ type: "text", text: responseText }],
			details: { data, status, error: errorMessage, keepGoing },
			data: { data, status, error: errorMessage, keepGoing },
			// PLAN-350 S2: the actual structural fix. A resolved terminal call halts the
			// agent loop SYNCHRONOUSLY (see agent-loop.ts runLoop) — the model never
			// regains a turn in which to call anything again unless the executor
			// deliberately re-prompts (bounded, gate-verification-aware). A checkpoint
			// (keepGoing) does not halt — the session continues normally.
			haltsLoop: !keepGoing,
		};
	}
}

// Register subprocess tool handler for extraction + termination.
//
// PLAN-350: `shouldTerminate` here is now REDUNDANT with the loop's own
// `haltsLoop` handling (agent-loop.ts runLoop stops synchronously on a
// haltsLoop:true result before this handler even runs) — kept as a second,
// independent signal for the subprocess EXECUTOR layer (task/executor.ts),
// which observes events async over the wire and has its own termination
// bookkeeping to update. `keepGoing` mirrors the same authority: a checkpoint
// (keepGoing:true) must NOT terminate the executor's subprocess tracking any
// more than it halts the in-process loop.
subprocessToolRegistry.register<SubmitResultDetails>("submit_result", {
	extractData: event => {
		const details = event.result?.details;
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const status = record.status;
		if (status !== "success" && status !== "aborted") return undefined;
		return {
			data: record.data,
			status,
			error: typeof record.error === "string" ? record.error : undefined,
			keepGoing: record.keepGoing === true,
		};
	},
	shouldTerminate: event => {
		if (event.isError) return false;
		const details = event.result?.details as Record<string, unknown> | undefined;
		return details?.keepGoing !== true;
	},
});
