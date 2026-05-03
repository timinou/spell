import type { Document, Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";

import { isEnoent, logger } from "@oh-my-pi/pi-utils";

import { readAllowedFolders, readStatusLineSegmentOptions, readTreeStringRecord } from "./kdl-compatibility";
import {
	getBooleanArgument,
	getBooleanProperty,
	getChildNode,
	getDocumentNode,
	getNumberArgument,
	getNumberProperty,
	getStringArgument,
	getStringArguments,
	getStringProperty,
} from "./kdl-helpers";
import { KDL_SETTINGS_MAP } from "./kdl-settings-map";
import type { RawSettings } from "./settings";
import { SETTINGS_SCHEMA, type SettingPath } from "./settings-schema";

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const segments = path.split(".");
	let current = target;
	for (let i = 0; i < segments.length - 1; i += 1) {
		const segment = segments[i];
		const next = current[segment];
		if (!next || typeof next !== "object" || Array.isArray(next)) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	current[segments[segments.length - 1]] = value;
}

function getNodeForPath(doc: Document, block: string, nodePath: string): Node | undefined {
	const root = getDocumentNode(doc, block);
	if (!root) return undefined;

	let current: Node | undefined = root;
	for (const segment of nodePath.split(".")) {
		current = current ? getChildNode(current, segment) : undefined;
		if (!current) return undefined;
	}
	return current;
}

function readSettingValue(node: Node, settingPath: SettingPath): unknown {
	const mapping = KDL_SETTINGS_MAP[settingPath];
	if (!mapping) return undefined;

	if (settingPath === "modelRoles" || settingPath === "task.agentModelOverrides") {
		const result = readTreeStringRecord(node, settingPath);
		for (const warning of result.warnings)
			logger.warn("kdl-reader: compatibility warning", { path: warning.path, message: warning.message });
		return result.value;
	}

	if (settingPath === "planMode.allowedFolders") {
		const result = readAllowedFolders(node);
		for (const warning of result.warnings)
			logger.warn("kdl-reader: compatibility warning", { path: warning.path, message: warning.message });
		return result.value;
	}

	if (settingPath === "statusLine.segmentOptions") {
		const result = readStatusLineSegmentOptions(node);
		for (const warning of result.warnings)
			logger.warn("kdl-reader: compatibility warning", { path: warning.path, message: warning.message });
		return result.value;
	}

	const schemaType = SETTINGS_SCHEMA[settingPath].type;
	if (schemaType === "array") return getStringArguments(node);
	if (mapping.accessor === "argument") {
		if (schemaType === "boolean") return getBooleanArgument(node);
		if (schemaType === "number") return getNumberArgument(node);
		return getStringArgument(node);
	}

	if (mapping.accessor === "property" && mapping.propertyName) {
		if (schemaType === "boolean") return getBooleanProperty(node, mapping.propertyName);
		if (schemaType === "number") return getNumberProperty(node, mapping.propertyName);
		return getStringProperty(node, mapping.propertyName);
	}

	return undefined;
}

export function kdlDocumentToSettings(doc: Document): RawSettings {
	const settings: RawSettings = {};

	for (const settingPath of Object.keys(KDL_SETTINGS_MAP) as SettingPath[]) {
		const mapping = KDL_SETTINGS_MAP[settingPath];
		if (!mapping) continue;

		const node = getNodeForPath(doc, mapping.block, mapping.nodePath);
		if (!node) continue;

		const value = readSettingValue(node, settingPath);
		if (value === undefined) continue;

		setByPath(settings, settingPath, value);
	}

	return settings;
}

export async function loadKdlSettings(filePath: string): Promise<RawSettings> {
	try {
		const content = await Bun.file(filePath).text();
		try {
			return kdlDocumentToSettings(parse(content));
		} catch (err) {
			logger.warn("kdl-reader: failed to parse spell.kdl", { filePath, error: String(err) });
			return {};
		}
	} catch (err) {
		if (isEnoent(err)) return {};
		throw err;
	}
}
