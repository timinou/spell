import { type Static, Type } from "@sinclair/typebox";

const LoopEventPayloadSchema = Type.Unknown();

export const LoopEventSchema = Type.Object(
	{
		version: Type.String({ minLength: 1 }),
		type: Type.String({ minLength: 1 }),
		loopId: Type.String({ minLength: 1 }),
		parentLoopId: Type.Optional(Type.String({ minLength: 1 })),
		timestamp: Type.Number(),
		payload: LoopEventPayloadSchema,
	},
	{ additionalProperties: false },
);

export type LoopEvent = Static<typeof LoopEventSchema>;
