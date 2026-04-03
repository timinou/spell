export type ActionScalar = string | number | boolean | null;

export type ActionValue =
	| ActionScalar
	| ActionValue[]
	| {
			[key: string]: ActionValue;
	  };

export type ActionParameterType = "string" | "number" | "boolean" | "string[]" | "number[]" | "boolean[]" | "json";

export interface ActionParameterDescriptor {
	type: ActionParameterType;
	required?: boolean;
}

export interface ActionPromptSlotDescriptor {
	required?: boolean;
}

export interface ActionDescriptor {
	id: string;
	source: "first-party";
	params?: Record<string, ActionParameterDescriptor>;
	promptSlots?: Record<string, ActionPromptSlotDescriptor>;
}

export interface ManifestActionPromptSlot {
	name: string;
	kind: "inline" | "file";
	content?: string;
	path?: string;
}

export interface ManifestAction {
	id: string;
	params: Record<string, ActionValue>;
	promptSlots: Record<string, ManifestActionPromptSlot>;
}
