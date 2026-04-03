import type { Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import type { GrowthSourceKind, GrowthSourceRecord } from "../types";

function stripTrackingParams(url: URL): URL {
	for (const key of [...url.searchParams.keys()]) {
		if (key.startsWith("utm_") || key === "ref" || key === "source") {
			url.searchParams.delete(key);
		}
	}
	url.hash = "";
	return url;
}

function normalizeUrlish(value: string): URL {
	try {
		return stripTrackingParams(new URL(value));
	} catch {
		return stripTrackingParams(new URL(`https://${value.replace(/^https?:\/\//, "")}`));
	}
}

export function normalizeSourceValue(kind: GrowthSourceKind, value: string): string {
	if (kind === "search") {
		return value.trim().replace(/\s+/g, " ");
	}
	if (kind === "x") {
		const trimmed = value.trim();
		if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
			const url = normalizeUrlish(trimmed);
			const [handle = ""] = url.pathname.split("/").filter(Boolean);
			return handle.toLowerCase();
		}
		return trimmed.replace(/^@/, "").toLowerCase();
	}
	if (kind === "linkedin") {
		const trimmed = value.trim();
		if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
			const url = normalizeUrlish(trimmed);
			const segments = url.pathname.split("/").filter(Boolean);
			return (segments.at(-1) ?? "").toLowerCase();
		}
		return trimmed.replace(/^@/, "").replace(/^\//, "").toLowerCase();
	}
	const url = normalizeUrlish(value.trim());
	const host = url.hostname.replace(/^www\./, "").toLowerCase();
	const pathname = url.pathname.replace(/\/+$/, "").replace(/^\//, "");
	return pathname ? `${host}/${pathname}` : host;
}

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

function expectOptionalStringProperty(node: Node, property: string): string | undefined {
	const value = node.getProperty(property);
	return typeof value === "string" ? value : undefined;
}

function expectOptionalBooleanProperty(node: Node, property: string): boolean | undefined {
	const value = node.getProperty(property);
	return typeof value === "boolean" ? value : undefined;
}

function expectOptionalNumberProperty(node: Node, property: string): number | undefined {
	const value = node.getProperty(property);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSourceNode(node: Node, index: number): GrowthSourceRecord {
	const slug = expectStringArgument(node, 0, `source.${index}.slug`);
	const label = expectStringProperty(node, "label", `source.${index}`);
	const kind = expectStringProperty(node, "kind", `source.${index}`) as GrowthSourceKind;
	if (!["website", "rss", "x", "linkedin", "newsletter", "search"].includes(kind)) {
		throw new Error(`source.${index}.kind is invalid`);
	}
	const value = expectStringProperty(node, "value", `source.${index}`);
	return {
		slug,
		label,
		kind,
		value,
		direct: expectOptionalBooleanProperty(node, "direct") ?? kind !== "search",
		priority: expectOptionalNumberProperty(node, "priority") ?? index + 1,
		...(expectOptionalStringProperty(node, "profile-url")
			? { profileUrl: expectOptionalStringProperty(node, "profile-url") }
			: {}),
	};
}

export function loadSourceRegistry(kdlText: string): GrowthSourceRecord[] {
	const document = parse(kdlText);
	const records = document.nodes
		.filter(node => node.getName() === "source")
		.map((node, index) => parseSourceNode(node, index));
	const slugSet = new Set<string>();
	const valueSet = new Set<string>();
	for (const record of records) {
		if (slugSet.has(record.slug)) {
			throw new Error(`Duplicate source slug: ${record.slug}`);
		}
		slugSet.add(record.slug);
		const normalized = `${record.kind}:${normalizeSourceValue(record.kind, record.value)}`;
		if (valueSet.has(normalized)) {
			throw new Error(`Duplicate source value: ${normalized}`);
		}
		valueSet.add(normalized);
	}
	return records.sort((left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug));
}
