import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import { resolveEnvValue } from "./env-resolver";
import { type DataConfig, type Persona, type Person, type PersonSource, type Source, isValidDataConfig } from "./data-types";

export interface ParseDataOptions {
	env?: Record<string, string | undefined>;
}

function createEmptyDataConfig(): DataConfig {
	return {
		personas: new Map(),
		persons: new Map(),
		sources: new Map(),
	};
}

function getNodeName(node: Node): string {
	return node.getName();
}

function resolveOptionalStringProperty(
	node: Node,
	property: string,
	pathLabel: string,
	options: ParseDataOptions,
): string | undefined {
	const value = node.getProperty(property);
	if (value === undefined) return undefined;
	return resolveEnvValue<string>(value, "string", `${pathLabel}.${property}`, options.env);
}

function resolveOptionalNumberProperty(
	node: Node,
	property: string,
	pathLabel: string,
	options: ParseDataOptions,
): number | undefined {
	const value = node.getProperty(property);
	if (value === undefined) return undefined;
	return resolveEnvValue<number>(value, "number", `${pathLabel}.${property}`, options.env);
}

function expectStringArgument(node: Node, pathLabel: string, index: number, options: ParseDataOptions): string {
	return resolveEnvValue<string>(node.getArgument(index), "string", pathLabel, options.env);
}

function requireStringProperty(node: Node, property: string, pathLabel: string, options: ParseDataOptions): string {
	const value = resolveOptionalStringProperty(node, property, pathLabel, options);
	if (value === undefined || value.length === 0) {
		throw new Error(`${pathLabel}.${property} is required`);
	}
	return value;
}

function parseChildStringValues(
	node: Node,
	childName: string,
	pathLabel: string,
	options: ParseDataOptions,
): string[] {
	const values: string[] = [];
	for (const [index, child] of (node.children?.nodes ?? []).entries()) {
		if (getNodeName(child) !== childName) continue;
		values.push(expectStringArgument(child, `${pathLabel}.${childName}.${index}`, 0, options));
	}
	return values;
}

function parsePersonSourceNode(node: Node, pathLabel: string, options: ParseDataOptions): PersonSource {
	const kind = requireStringProperty(node, "kind", pathLabel, options);
	const value = requireStringProperty(node, "value", pathLabel, options);
	const priority = resolveOptionalNumberProperty(node, "priority", pathLabel, options);
	return {
		kind,
		value,
		...(priority !== undefined ? { priority } : {}),
	} satisfies PersonSource;
}

function parsePersonaNode(node: Node, pathLabel: string, options: ParseDataOptions): Persona {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	return {
		id,
		name: requireStringProperty(node, "name", pathLabel, options),
		summary: requireStringProperty(node, "summary", pathLabel, options),
		goals: parseChildStringValues(node, "goal", pathLabel, options),
		challenges: parseChildStringValues(node, "challenge", pathLabel, options),
		keywords: parseChildStringValues(node, "keyword", pathLabel, options),
	} satisfies Persona;
}

function parsePersonNode(node: Node, pathLabel: string, options: ParseDataOptions): Person {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const role = resolveOptionalStringProperty(node, "role", pathLabel, options);
	const url = resolveOptionalStringProperty(node, "url", pathLabel, options);
	const sources: PersonSource[] = [];
	for (const [index, child] of (node.children?.nodes ?? []).entries()) {
		const childName = getNodeName(child);
		if (childName !== "source") {
			throw new Error(`${pathLabel} has unsupported child "${childName}" at index ${index}`);
		}
		sources.push(parsePersonSourceNode(child, `${pathLabel}.source.${sources.length}`, options));
	}
	return {
		id,
		name: requireStringProperty(node, "name", pathLabel, options),
		...(role !== undefined ? { role } : {}),
		...(url !== undefined ? { url } : {}),
		sources,
	} satisfies Person;
}

function parseSourceNode(node: Node, pathLabel: string, options: ParseDataOptions): Source {
	const id = expectStringArgument(node, `${pathLabel}.id`, 0, options);
	const priority = resolveOptionalNumberProperty(node, "priority", pathLabel, options);
	if (priority === undefined) {
		throw new Error(`${pathLabel}.priority is required`);
	}
	return {
		id,
		label: requireStringProperty(node, "label", pathLabel, options),
		kind: requireStringProperty(node, "kind", pathLabel, options),
		value: requireStringProperty(node, "value", pathLabel, options),
		priority,
	} satisfies Source;
}

function setUniqueEntry<T>(map: Map<string, T>, id: string, value: T, label: string, errors: string[]): void {
	if (map.has(id)) {
		errors.push(`Duplicate ${label} id "${id}"`);
		return;
	}
	map.set(id, value);
}

export function parseDataConfigKdl(kdlText: string, options: ParseDataOptions = {}): DataConfig {
	const document = parse(kdlText);
	const config = createEmptyDataConfig();
	const errors: string[] = [];

	for (const [index, node] of document.nodes.entries()) {
		const nodeName = getNodeName(node);
		const pathLabel = `data.${nodeName}.${index}`;
		try {
			if (nodeName === "persona") {
				const persona = parsePersonaNode(node, pathLabel, options);
				setUniqueEntry(config.personas, persona.id, persona, "persona", errors);
				continue;
			}
			if (nodeName === "person") {
				const person = parsePersonNode(node, pathLabel, options);
				setUniqueEntry(config.persons, person.id, person, "person", errors);
				continue;
			}
			if (nodeName === "source") {
				const source = parseSourceNode(node, pathLabel, options);
				setUniqueEntry(config.sources, source.id, source, "source", errors);
				continue;
			}
			errors.push(`${pathLabel} has unsupported top-level node "${nodeName}"`);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	if (errors.length > 0) {
		throw new Error(errors.join("\n"));
	}
	if (!isValidDataConfig(config)) {
		throw new Error("Parsed data config does not match data config schema");
	}
	return config;
}

function mergeDataConfig(target: DataConfig, incoming: DataConfig, sourcePath: string): void {
	const errors: string[] = [];
	for (const [id, persona] of incoming.personas) {
		if (target.personas.has(id)) {
			errors.push(`Duplicate persona id "${id}" across files including ${sourcePath}`);
			continue;
		}
		target.personas.set(id, persona);
	}
	for (const [id, person] of incoming.persons) {
		if (target.persons.has(id)) {
			errors.push(`Duplicate person id "${id}" across files including ${sourcePath}`);
			continue;
		}
		target.persons.set(id, person);
	}
	for (const [id, source] of incoming.sources) {
		if (target.sources.has(id)) {
			errors.push(`Duplicate source id "${id}" across files including ${sourcePath}`);
			continue;
		}
		target.sources.set(id, source);
	}
	if (errors.length > 0) {
		throw new Error(errors.join("\n"));
	}
}

export async function loadDataDirectory(dirPath: string, options: ParseDataOptions = {}): Promise<DataConfig> {
	const config = createEmptyDataConfig();
	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	const fileNames = entries
		.filter(entry => entry.isFile() && entry.name.endsWith(".kdl"))
		.map(entry => entry.name)
		.sort((left, right) => left.localeCompare(right));

	for (const fileName of fileNames) {
		const filePath = path.join(dirPath, fileName);
		const kdlText = await fs.readFile(filePath, "utf8");
		const parsed = parseDataConfigKdl(kdlText, options);
		mergeDataConfig(config, parsed, filePath);
	}

	if (!isValidDataConfig(config)) {
		throw new Error("Loaded data config does not match data config schema");
	}
	return config;
}
