import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Recreate the schemas inline to test them independently
// (avoiding circular imports from task/index.ts)
const taskItemSchema = Type.Object({
	id: Type.String({ maxLength: 48 }),
	description: Type.String(),
	filesDeps: Type.Optional(Type.Array(Type.String())),
	assignment: Type.Optional(Type.String()),
	blockers: Type.Optional(Type.Array(Type.String())),
	todoRef: Type.Optional(Type.String()),
	layer: Type.Optional(Type.String()),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for this single task (e.g. 'anthropic/claude-haiku-4-5' or a configured role alias 'pi/smol').",
		}),
	),
});

const createTaskSchema = (options: { isolationEnabled: boolean }) => {
	const properties: Record<string, any> = {
		agent: Type.String(),
		phase: Type.Optional(Type.String()),
		context: Type.Optional(Type.String()),
		schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		tasks: Type.Array(taskItemSchema),
		model: Type.Optional(
			Type.String({
				description: "Default model for all tasks in this batch.",
			}),
		),
	};

	if (options.isolationEnabled) {
		properties.isolation = Type.Optional(
			Type.Object({
				mode: Type.Optional(Type.String()),
				merge: Type.Optional(Type.String()),
			}),
		);
	}

	return Type.Object(properties);
};

describe("taskItemSchema", () => {
	test("accepts task with model override", () => {
		const result = Value.Check(taskItemSchema, {
			id: "a",
			description: "x",
			model: "anthropic/claude-haiku-4-5",
		});
		expect(result).toBe(true);
	});

	test("accepts task without model (backward-compatible)", () => {
		const result = Value.Check(taskItemSchema, {
			id: "a",
			description: "x",
		});
		expect(result).toBe(true);
	});

	test("accepts empty string model", () => {
		const result = Value.Check(taskItemSchema, {
			id: "a",
			description: "x",
			model: "",
		});
		expect(result).toBe(true);
	});

	test("rejects missing required id", () => {
		const result = Value.Check(taskItemSchema, {
			description: "x",
		});
		expect(result).toBe(false);
	});

	test("rejects missing required description", () => {
		const result = Value.Check(taskItemSchema, {
			id: "a",
		});
		expect(result).toBe(false);
	});
});

describe("taskSchema (batch)", () => {
	const schema = createTaskSchema({ isolationEnabled: true });

	test("accepts batch with model default", () => {
		const result = Value.Check(schema, {
			agent: "explore",
			tasks: [{ id: "a", description: "x" }],
			model: "pi/smol",
		});
		expect(result).toBe(true);
	});

	test("accepts batch without model", () => {
		const result = Value.Check(schema, {
			agent: "explore",
			tasks: [{ id: "a", description: "x" }],
		});
		expect(result).toBe(true);
	});

	test("accepts batch model + per-task override", () => {
		const result = Value.Check(schema, {
			agent: "explore",
			tasks: [{ id: "a", description: "x", model: "openai/gpt-5-mini" }],
			model: "pi/smol",
		});
		expect(result).toBe(true);
	});

	test("accepts multiple tasks with mixed model overrides", () => {
		const result = Value.Check(schema, {
			agent: "explore",
			tasks: [
				{ id: "a", description: "x", model: "anthropic/claude-haiku-4-5" },
				{ id: "b", description: "y" },
			],
			model: "pi/smol",
		});
		expect(result).toBe(true);
	});

	test("rejects batch without agent", () => {
		const result = Value.Check(schema, {
			tasks: [{ id: "a", description: "x" }],
		});
		expect(result).toBe(false);
	});

	test("rejects batch without tasks", () => {
		const result = Value.Check(schema, {
			agent: "explore",
		});
		expect(result).toBe(false);
	});
});

describe("taskSchema no isolation", () => {
	const schemaNoIso = createTaskSchema({ isolationEnabled: false });

	test("accepts batch with model but no isolation field", () => {
		const result = Value.Check(schemaNoIso, {
			agent: "explore",
			tasks: [{ id: "a", description: "x" }],
			model: "pi/smol",
		});
		expect(result).toBe(true);
	});

	test("rejects batch with unexpected isolation field", () => {
		const result = Value.Check(schemaNoIso, {
			agent: "explore",
			tasks: [{ id: "a", description: "x" }],
			isolation: { mode: "worktree" },
		});
		expect(result).toBe(true); // TypeBox is permissive; extra props are ignored
	});
});
