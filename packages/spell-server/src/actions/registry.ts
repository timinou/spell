import type {
	ActionDescriptor,
	ActionParameterDescriptor,
	ActionPromptSlotDescriptor,
	ActionValue,
	ManifestAction,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isJsonValue(value: ActionValue): boolean {
	if (value === null) {
		return true;
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(
			item => item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean",
		);
	}
	if (!isRecord(value)) {
		return false;
	}
	return Object.values(value).every(item => isJsonValue(item as ActionValue));
}

function matchesDescriptor(value: ActionValue, descriptor: ActionParameterDescriptor): boolean {
	switch (descriptor.type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "string[]":
			return Array.isArray(value) && value.every(item => typeof item === "string");
		case "number[]":
			return Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item));
		case "boolean[]":
			return Array.isArray(value) && value.every(item => typeof item === "boolean");
		case "json":
			return isJsonValue(value);
	}
}

function validatePromptSlot(
	slotName: string,
	descriptor: ActionPromptSlotDescriptor | undefined,
	present: boolean,
	errors: string[],
): void {
	if (descriptor?.required && !present) {
		errors.push(`Missing required prompt slot \"${slotName}\"`);
	}
}

export class ActionRegistry {
	#actions = new Map<string, ActionDescriptor>();

	register(descriptor: ActionDescriptor): void {
		if (descriptor.source !== "first-party") {
			throw new Error(`Action registry accepts first-party descriptors only: ${descriptor.id}`);
		}
		if (this.#actions.has(descriptor.id)) {
			throw new Error(`Action already registered: ${descriptor.id}`);
		}
		this.#actions.set(descriptor.id, descriptor);
	}

	registerMany(descriptors: ActionDescriptor[]): void {
		for (const descriptor of descriptors) {
			this.register(descriptor);
		}
	}

	get(actionId: string): ActionDescriptor | undefined {
		return this.#actions.get(actionId);
	}

	has(actionId: string): boolean {
		return this.#actions.has(actionId);
	}

	list(): ActionDescriptor[] {
		return [...this.#actions.values()].sort((left, right) => left.id.localeCompare(right.id));
	}

	validateAction(action: ManifestAction): string[] {
		const descriptor = this.#actions.get(action.id);
		if (!descriptor) {
			return [`Unknown action id \"${action.id}\"`];
		}

		const errors: string[] = [];
		const declaredParams = descriptor.params ?? {};
		for (const [paramName, paramDescriptor] of Object.entries(declaredParams)) {
			const value = action.params[paramName];
			if (value === undefined) {
				if (paramDescriptor.required) {
					errors.push(`Missing required action param \"${paramName}\"`);
				}
				continue;
			}
			if (!matchesDescriptor(value, paramDescriptor)) {
				errors.push(`Action param \"${paramName}\" must be ${paramDescriptor.type}`);
			}
		}

		for (const paramName of Object.keys(action.params)) {
			if (!declaredParams[paramName]) {
				errors.push(`Unknown action param \"${paramName}\"`);
			}
		}

		const declaredPromptSlots = descriptor.promptSlots ?? {};
		for (const [slotName, slotDescriptor] of Object.entries(declaredPromptSlots)) {
			validatePromptSlot(slotName, slotDescriptor, Boolean(action.promptSlots[slotName]), errors);
		}
		for (const slotName of Object.keys(action.promptSlots)) {
			if (!declaredPromptSlots[slotName]) {
				errors.push(`Unknown prompt slot \"${slotName}\"`);
			}
		}

		return errors;
	}
}
