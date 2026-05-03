/**
 * Shared KDL node accessor/mutator helpers.
 *
 * Extracted from task-policies-kdl.ts and extended for the full
 * spell.kdl config format. All block parsers and the KDL writer
 * import from this module.
 */

import type { Node } from "@bgotink/kdl";
import { Document, Node as NodeClass } from "@bgotink/kdl";

// ═══════════════════════════════════════════════════════════════════════════
// Argument Accessors
// ═══════════════════════════════════════════════════════════════════════════

/** Get a string argument at the given index. Returns undefined for missing or non-string values. */
export function getStringArgument(node: Node, index = 0): string | undefined {
	const value = node.getArgument(index);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Get a boolean argument at the given index. Returns undefined for missing or non-boolean values. */
export function getBooleanArgument(node: Node, index = 0): boolean | undefined {
	const value = node.getArgument(index);
	return typeof value === "boolean" ? value : undefined;
}

/** Get a number argument at the given index. Returns undefined for missing or non-number values. */
export function getNumberArgument(node: Node, index = 0): number | undefined {
	const value = node.getArgument(index);
	return typeof value === "number" ? value : undefined;
}

/** Get all string arguments from a node. Non-string arguments are skipped. */
export function getStringArguments(node: Node): string[] {
	return node.getArguments().filter((v): v is string => typeof v === "string" && v.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Property Accessors
// ═══════════════════════════════════════════════════════════════════════════

/** Get a string property by name. Returns undefined for missing or non-string values. */
export function getStringProperty(node: Node, name: string): string | undefined {
	const value = node.getProperty(name);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Get a number property by name. Returns undefined for missing or non-number values. */
export function getNumberProperty(node: Node, name: string): number | undefined {
	const value = node.getProperty(name);
	return typeof value === "number" ? value : undefined;
}

/** Get a boolean property by name. Returns undefined for missing or non-boolean values. */
export function getBooleanProperty(node: Node, name: string): boolean | undefined {
	const value = node.getProperty(name);
	return typeof value === "boolean" ? value : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Child Node Navigation
// ═══════════════════════════════════════════════════════════════════════════

/** Get a child node by name from a node's children block. Returns undefined if not found or no children block. */
export function getChildNode(parent: Node, name: string): Node | undefined {
	return parent.children?.findNodeByName(name) ?? undefined;
}

/** Get all child nodes, optionally filtered by name. Returns empty array when no children block exists. */
export function getChildNodes(parent: Node, name?: string): Node[] {
	if (!parent.children) return [];
	if (name !== undefined) return parent.children.findNodesByName(name);
	return parent.children.nodes;
}

/** Get a top-level node by name from a document. Returns undefined if not found. */
export function getDocumentNode(doc: Document, name: string): Node | undefined {
	return doc.findNodeByName(name) ?? undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Node Creation Helpers (for writer)
// ═══════════════════════════════════════════════════════════════════════════

/** Create a node with a single string argument. */
export function createStringNode(name: string, value: string): Node {
	const node = NodeClass.create(name);
	node.addArgument(value);
	return node;
}

/** Create a node with a single boolean argument. */
export function createBooleanNode(name: string, value: boolean): Node {
	const node = NodeClass.create(name);
	node.addArgument(value);
	return node;
}

/** Create a node with a single number argument. */
export function createNumberNode(name: string, value: number): Node {
	const node = NodeClass.create(name);
	node.addArgument(value);
	return node;
}

/** Create a node with named properties. */
export function createPropertyNode(name: string, props: Record<string, string | number | boolean>): Node {
	const node = NodeClass.create(name);
	for (const [key, value] of Object.entries(props)) {
		node.setProperty(key, value);
	}
	return node;
}

/**
 * Ensure a node has a children block (Document). If the node has no children
 * block, creates an empty one. Returns the children Document.
 */
export function ensureChildrenBlock(node: Node): Document {
	if (!node.children) {
		node.children = new Document([]);
	}
	return node.children;
}

/**
 * Find or create a child node by name within a parent node's children block.
 * If the child doesn't exist, creates it and appends to the parent's children.
 */
export function findOrCreateChildNode(parent: Node, name: string): Node {
	const existing = getChildNode(parent, name);
	if (existing) return existing;

	const child = NodeClass.create(name);
	const children = ensureChildrenBlock(parent);
	children.appendNode(child);
	return child;
}

/**
 * Find or create a top-level node by name within a document.
 * If the node doesn't exist, creates it and appends to the document.
 */
export function findOrCreateDocumentNode(doc: Document, name: string): Node {
	const existing = getDocumentNode(doc, name);
	if (existing) return existing;

	const node = NodeClass.create(name);
	doc.appendNode(node);
	return node;
}

/**
 * Set an argument value on a node. If the node already has an argument at the
 * given index, replaces it. Otherwise adds a new argument.
 */
export function setArgument(node: Node, value: string | number | boolean, index = 0): void {
	if (node.hasArgument(index)) {
		const entry = node.getArgumentEntry(index);
		if (entry) entry.setValue(value);
	} else {
		node.addArgument(value);
	}
}
