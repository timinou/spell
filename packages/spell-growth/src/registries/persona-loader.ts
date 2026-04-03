import type { Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import type { GrowthPersonaRecord } from "../types";

function expectStringArgument(node: Node, index: number, pathLabel: string): string {
	const value = node.getArgument(index);
	if (typeof value !== "string") {
		throw new Error(`${pathLabel} must be a string`);
	}
	return value;
}

function expectStringProperty(node: Node, property: string, pathLabel: string): string {
	const value = node.getProperty(property);
	if (typeof value !== "string") {
		throw new Error(`${pathLabel}.${property} must be a string`);
	}
	return value;
}

function readList(node: Node, name: string): string[] {
	return (node.children?.findNodesByName(name) ?? []).map((child, index) => {
		const value = child.getArgument(0);
		if (typeof value !== "string") {
			throw new Error(`persona.${name}.${index} must be a string`);
		}
		return value;
	});
}

function parsePersonaNode(node: Node, index: number): GrowthPersonaRecord {
	return {
		slug: expectStringArgument(node, 0, `persona.${index}.slug`),
		name: expectStringProperty(node, "name", `persona.${index}`),
		summary: expectStringProperty(node, "summary", `persona.${index}`),
		goals: readList(node, "goal"),
		challenges: readList(node, "challenge"),
		keywords: readList(node, "keyword"),
	};
}

export function loadPersonaRegistry(kdlText: string): GrowthPersonaRecord[] {
	const document = parse(kdlText);
	const personas = document.nodes
		.filter(node => node.getName() === "persona")
		.map((node, index) => parsePersonaNode(node, index));
	const slugSet = new Set<string>();
	for (const persona of personas) {
		if (slugSet.has(persona.slug)) {
			throw new Error(`Duplicate persona slug: ${persona.slug}`);
		}
		slugSet.add(persona.slug);
		if (persona.name.trim() === "" || persona.summary.trim() === "") {
			throw new Error(`Persona ${persona.slug} is missing required fields`);
		}
	}
	return personas;
}
