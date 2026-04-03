export interface Persona {
	id: string;
	name: string;
	summary: string;
	goals: string[];
	challenges: string[];
	keywords: string[];
}

export interface PersonSource {
	kind: string;
	value: string;
	priority?: number;
}

export interface Person {
	id: string;
	name: string;
	role?: string;
	url?: string;
	sources: PersonSource[];
}

export interface Source {
	id: string;
	label: string;
	kind: string;
	value: string;
	priority: number;
}

export interface DataConfig {
	personas: Map<string, Persona>;
	persons: Map<string, Person>;
	sources: Map<string, Source>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

export function isValidPersona(value: unknown): value is Persona {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.name === "string" &&
		typeof value.summary === "string" &&
		isStringArray(value.goals) &&
		isStringArray(value.challenges) &&
		isStringArray(value.keywords)
	);
}

export function isValidPersonSource(value: unknown): value is PersonSource {
	if (!isRecord(value)) return false;
	return typeof value.kind === "string" && typeof value.value === "string" && isOptionalFiniteNumber(value.priority);
}

export function isValidPerson(value: unknown): value is Person {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.name === "string" &&
		(value.role === undefined || typeof value.role === "string") &&
		(value.url === undefined || typeof value.url === "string") &&
		Array.isArray(value.sources) &&
		value.sources.every(source => isValidPersonSource(source))
	);
}

export function isValidSource(value: unknown): value is Source {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.label === "string" &&
		typeof value.kind === "string" &&
		typeof value.value === "string" &&
		typeof value.priority === "number" &&
		Number.isFinite(value.priority)
	);
}

export function isValidDataConfig(value: unknown): value is DataConfig {
	if (!isRecord(value)) return false;
	if (!(value.personas instanceof Map) || !(value.persons instanceof Map) || !(value.sources instanceof Map)) return false;
	return (
		[...value.personas.entries()].every(([id, persona]) => typeof id === "string" && isValidPersona(persona)) &&
		[...value.persons.entries()].every(([id, person]) => typeof id === "string" && isValidPerson(person)) &&
		[...value.sources.entries()].every(([id, source]) => typeof id === "string" && isValidSource(source))
	);
}
