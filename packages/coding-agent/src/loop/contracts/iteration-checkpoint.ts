import { type Static, Type } from "@sinclair/typebox";
import { LoopStateSchema } from "./enums";

export const IterationCheckpointSchema = Type.Object(
	{
		loopId: Type.String({ minLength: 1 }),
		iteration: Type.Integer({ minimum: 0 }),
		state: LoopStateSchema,
		timestamp: Type.Number(),
		taskFileHash: Type.String(),
		orgItemId: Type.String({ minLength: 1 }),
		childLoopIds: Type.Array(Type.String()),
		pendingGates: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export type IterationCheckpoint = Static<typeof IterationCheckpointSchema>;
