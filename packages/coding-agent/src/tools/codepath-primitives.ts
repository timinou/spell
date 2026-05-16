import { Type } from "@sinclair/typebox";

export const filePathSchema = Type.String({
	pattern: "^[^:]*$|^[^:]*:[^:].*$",
	description: "Bare file path; MUST NOT contain '::' (symbol separator)",
});

export const symbolPathSchema = Type.String({
	pattern: "^.+::.+$",
	description: "Symbol target; MUST contain '::Symbol[.member]'",
});

export const contentSchema = Type.Union([Type.String(), Type.Array(Type.String())]);

export const symScopeSchema = Type.Union([Type.Literal("whole"), Type.Literal("body"), Type.Literal("sig")]);

export const occurrenceSchema = Type.Union([
	Type.Literal("first"),
	Type.Literal("last"),
	Type.Literal("all"),
	Type.Integer({ minimum: 1 }),
]);

export const directionSchema = Type.Union([Type.Literal("up"), Type.Literal("down")]);
export const spliceModeSchema = Type.Union([Type.Literal("self"), Type.Literal("up"), Type.Literal("down")]);

export const lineAnchorSchema = Type.String({
	pattern: "^\\d+#.+$",
	description: "LINE#HASH anchor copied from get output (e.g. '42#ZP')",
});

export const lineSpanSchema = Type.Object({
	start: lineAnchorSchema,
	end: Type.Optional(lineAnchorSchema),
});

export const lineAtSchema = Type.Union([
	Type.Object({ side: Type.Literal("before"), anchor: lineAnchorSchema }),
	Type.Object({ side: Type.Literal("after"), anchor: lineAnchorSchema }),
]);

