import { Document, type Node, Node as NodeClass } from "@bgotink/kdl";

import { getChildNodes, getStringArgument } from "./kdl-helpers";

export interface KdlCompatWarning {
	path: string;
	message: string;
}

export interface KdlCompatResult<T> {
	value: T;
	warnings: KdlCompatWarning[];
}

const STATUS_LINE_SEGMENT_PROPS = {
	model: { "show-thinking-level": "showThinkingLevel" },
	path: {
		abbreviate: "abbreviate",
		"max-length": "maxLength",
		"strip-work-prefix": "stripWorkPrefix",
	},
	git: {
		"show-branch": "showBranch",
		"show-staged": "showStaged",
		"show-unstaged": "showUnstaged",
		"show-untracked": "showUntracked",
	},
	time: {
		format: "format",
		"show-seconds": "showSeconds",
	},
} as const;

type KnownStatusLineSegment = keyof typeof STATUS_LINE_SEGMENT_PROPS;

function clearNodeEntries(node: Node): void {
	const mutableNode = node as Node & { entries?: unknown[] };
	mutableNode.entries = [];
}

function createNodeWithStringArgument(name: string, value: string): Node {
	const node = NodeClass.create(name);
	node.addArgument(value);
	return node;
}

function setStringRecordChildren(node: Node, entries: Array<[string, string]>): void {
	clearNodeEntries(node);
	node.children = new Document(entries.map(([name, value]) => createNodeWithStringArgument(name, value)));
}

function readLegacyPropertyBag(node: Node, warningPath: string): KdlCompatResult<Record<string, string>> {
	const value: Record<string, string> = {};
	const warnings: KdlCompatWarning[] = [];
	for (const [key, propertyValue] of node.getProperties()) {
		if (typeof propertyValue !== "string") continue;
		value[key] = propertyValue;
	}
	if (Object.keys(value).length > 0) {
		warnings.push({
			path: warningPath,
			message: "legacy property-bag shape read for compatibility; writer will canonicalize child nodes",
		});
	}
	return { value, warnings };
}

function toCamelCase(name: string): string {
	return name.replaceAll(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function toKebabCase(name: string): string {
	return name.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function isKnownStatusLineSegment(name: string): name is KnownStatusLineSegment {
	return Object.hasOwn(STATUS_LINE_SEGMENT_PROPS, name);
}

function readKnownSegmentProperties(segment: KnownStatusLineSegment, node: Node): Record<string, unknown> {
	const mapping = STATUS_LINE_SEGMENT_PROPS[segment];
	const value: Record<string, unknown> = {};
	for (const [key, propertyValue] of node.getProperties()) {
		const normalizedKey = mapping[key as keyof typeof mapping] ?? toCamelCase(key);
		value[normalizedKey] = propertyValue;
	}
	return value;
}

function writeKnownSegmentProperties(
	segment: KnownStatusLineSegment,
	node: Node,
	value: Record<string, unknown>,
): void {
	const reverseMapping = Object.fromEntries(
		Object.entries(STATUS_LINE_SEGMENT_PROPS[segment]).map(([kdlName, internalName]) => [internalName, kdlName]),
	);
	for (const [key, propertyValue] of Object.entries(value)) {
		const normalizedKey = reverseMapping[key] ?? toKebabCase(key);
		node.setProperty(normalizedKey, propertyValue as never);
	}
}

function readChildStringEntries(node: Node): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	for (const child of getChildNodes(node)) {
		const value = getStringArgument(child);
		if (value !== undefined) entries.push([child.getName(), value]);
	}
	return entries;
}

export function readTreeStringRecord(node: Node, warningPath: string): KdlCompatResult<Record<string, string>> {
	const legacy = readLegacyPropertyBag(node, warningPath);
	const value = { ...legacy.value };
	for (const [name, entryValue] of readChildStringEntries(node)) value[name] = entryValue;
	return { value, warnings: legacy.warnings };
}

export function writeTreeStringRecord(node: Node, value: Record<string, string>): void {
	setStringRecordChildren(node, Object.entries(value));
}

export function readAllowedFolders(node: Node): KdlCompatResult<Record<string, string>> {
	const legacy = readLegacyPropertyBag(node, "planMode.allowedFolders");
	const value = { ...legacy.value };
	const warnings = [...legacy.warnings];
	for (const child of getChildNodes(node)) {
		if (child.getName() !== "folder") {
			warnings.push({
				path: `planMode.allowedFolders.${child.getName()}`,
				message: "unknown node preserved outside canonical allowed-folders entries",
			});
			continue;
		}
		const folderPath = getStringArgument(child);
		if (!folderPath) continue;
		const description = child.getProperty("description");
		value[folderPath] = typeof description === "string" ? description : "";
	}
	return { value, warnings };
}

export function writeAllowedFolders(node: Node, value: Record<string, string>): void {
	clearNodeEntries(node);
	const children = new Document([]);
	for (const [folderPath, description] of Object.entries(value)) {
		const child = NodeClass.create("folder");
		child.addArgument(folderPath);
		child.setProperty("description", description);
		children.appendNode(child);
	}
	node.children = children;
}

export function readStatusLineSegmentOptions(node: Node): KdlCompatResult<Record<string, unknown>> {
	const value: Record<string, unknown> = {};
	const warnings: KdlCompatWarning[] = [];
	for (const child of getChildNodes(node)) {
		const childName = child.getName();
		if (childName === "segment") {
			const legacyName = getStringArgument(child);
			if (!legacyName) continue;
			value[legacyName] = Object.fromEntries(child.getProperties());
			warnings.push({
				path: `statusLine.segmentOptions.${legacyName}`,
				message: "legacy generic segment shape read for compatibility; writer will canonicalize typed child blocks",
			});
			continue;
		}

		if (isKnownStatusLineSegment(childName)) {
			value[childName] = readKnownSegmentProperties(childName, child);
			continue;
		}

		value[childName] = Object.fromEntries(child.getProperties());
		warnings.push({
			path: `statusLine.segmentOptions.${childName}`,
			message: "unknown segment block preserved during round-trip",
		});
	}
	return { value, warnings };
}

export function writeStatusLineSegmentOptions(node: Node, value: Record<string, unknown>): void {
	clearNodeEntries(node);
	const children = new Document([]);
	for (const [segmentName, segmentValue] of Object.entries(value)) {
		if (!segmentValue || typeof segmentValue !== "object" || Array.isArray(segmentValue)) continue;
		const child = NodeClass.create(segmentName);
		if (isKnownStatusLineSegment(segmentName)) {
			writeKnownSegmentProperties(segmentName, child, segmentValue as Record<string, unknown>);
		} else {
			for (const [key, propertyValue] of Object.entries(segmentValue)) {
				child.setProperty(key, propertyValue as never);
			}
		}
		children.appendNode(child);
	}
	node.children = children;
}
