import { type Static, Type } from "@sinclair/typebox";

export const ServiceEntrySchema = Type.Object({
	name: Type.String({ minLength: 1, description: "Unique key, e.g. 'linkedin', 'google-personal'" }),
	displayName: Type.String({ description: "Human-readable name, e.g. 'LinkedIn'" }),
	description: Type.String({ description: "AI hint for agent context" }),
	profileStorage: Type.String({ minLength: 1, description: "WebEngine storageName (sanitized)" }),
	domains: Type.Array(Type.String(), { description: "Exact domain matches" }),
	parentService: Type.Optional(Type.String({ description: "Parent service name (shares profileStorage)" })),
	loginUrl: Type.Optional(Type.String({ description: "URL for agent-driven reconnection" })),
	faviconPath: Type.Optional(Type.String({ description: "Absolute path to extracted favicon PNG" })),
	lastUsed: Type.Optional(Type.String({ description: "ISO 8601 datetime" })),
	lastValidated: Type.Optional(Type.String({ description: "ISO 8601 datetime" })),
	status: Type.Union([Type.Literal("connected"), Type.Literal("unknown")], {
		description: "Session status",
	}),
});

export type ServiceEntry = Static<typeof ServiceEntrySchema>;

export const ServiceRegistryFileSchema = Type.Object({
	services: Type.Record(Type.String(), ServiceEntrySchema),
});

export type ServiceRegistryFile = Static<typeof ServiceRegistryFileSchema>;
