import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Document, format, type Node, parse } from "@bgotink/kdl";
import { isEnoent } from "@oh-my-pi/pi-utils";

import { withFileLock } from "./file-lock";
import {
	writeAllowedFolders,
	writeSecrets,
	writeStatusLineSegmentOptions,
	writeTreeStringRecord,
	type SecretsKdlEntry,
} from "./kdl-compatibility";
import { findOrCreateChildNode, findOrCreateDocumentNode, setArgument } from "./kdl-helpers";
import { getKdlMapping } from "./kdl-settings-map";

function isNodeArrayValue(value: unknown): value is Array<string | number | boolean> {
	return (
		Array.isArray(value) &&
		value.every(item => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
	);
}

function clearArguments(node: Node): void {
	const mutableNode = node as Node & { entries?: unknown[] };
	mutableNode.entries = [];
}

function setNodeValue(node: Node, value: unknown): void {
	if (isNodeArrayValue(value)) {
		clearArguments(node);
		for (const item of value) node.addArgument(item);
		return;
	}

	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		setArgument(node, value);
	}
}

function applySetting(doc: Document, path: string, value: unknown): void {
	const mapping = getKdlMapping(path);
	if (!mapping) return;

	// Block-only settings: writer operates on the top-level node directly.
	if (path === "secrets") {
		const blockNode = findOrCreateDocumentNode(doc, mapping.block);
		writeSecrets(blockNode, value as SecretsKdlEntry[]);
		return;
	}

	const blockNode = findOrCreateDocumentNode(doc, mapping.block);
	const segments = mapping.nodePath.split(".");
	let current = blockNode;
	for (const segment of segments) current = findOrCreateChildNode(current, segment);

	if (path === "modelRoles" || path === "task.agentModelOverrides") {
		writeTreeStringRecord(current, value as Record<string, string>);
		return;
	}

	if (path === "planMode.allowedFolders") {
		writeAllowedFolders(current, value as Record<string, string>);
		return;
	}

	if (path === "statusLine.segmentOptions") {
		writeStatusLineSegmentOptions(current, value as Record<string, unknown>);
		return;
	}

	if (mapping.accessor === "property") {
		if (mapping.propertyName) current.setProperty(mapping.propertyName, value as never);
		return;
	}

	setNodeValue(current, value);
}

export function applySettingsToKdl(doc: Document, changes: Map<string, unknown>): Document {
	for (const [path, value] of changes) applySetting(doc, path, value);
	return doc;
}

export async function writeKdlSettings(filePath: string, changes: Map<string, unknown>): Promise<void> {
	// Ensure parent directory exists. First-write on a fresh install targets a
	// path whose parent may not exist (e.g. ~/.config/spell/ on a clean home).
	// withFileLock uses fs.mkdir(lockPath) without recursion — it ENOENTs if the
	// parent is missing. Materialize the directory up-front.
	await fs.mkdir(path.dirname(filePath), { recursive: true });

	await withFileLock(filePath, async () => {
		let doc: Document;
		try {
			const content = await Bun.file(filePath).text();
			doc = parse(content);
		} catch (err) {
			if (!isEnoent(err)) throw err;
			doc = new Document([]);
		}

		applySettingsToKdl(doc, changes);
		await Bun.write(filePath, format(doc));
	});
}
