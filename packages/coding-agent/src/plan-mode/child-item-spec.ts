import { safeTruncateUtf8 } from "../utils/safe-truncate-utf8";
import type { ResolvedPlanChildItem } from "./plan-validation";

export interface ChildItemSpec {
	id: string;
	title?: string;
	body: string;
	properties: Record<string, string>;
}

export interface RenderedChildItemSpec extends ChildItemSpec {
	propertiesLine: string;
	truncated: boolean;
}

interface BuildChildItemSpecsOptions {
	perChildMaxBytes: number;
	globalMaxBytes: number;
}

function clampMaxBytes(maxBytes: number): number {
	if (!Number.isFinite(maxBytes)) return Number.MAX_SAFE_INTEGER;
	return Math.max(1, Math.floor(maxBytes));
}

function extractChildTitle(body: string): string | undefined {
	const headingMatch = /^\*\s+(.+)$/mu.exec(body);
	return headingMatch?.[1]?.trim() || undefined;
}

export function renderChildItemSpec(spec: ChildItemSpec & { truncated?: boolean }): RenderedChildItemSpec {
	const propertiesLine = Object.entries(spec.properties)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${value}`)
		.join(", ");

	return {
		...spec,
		propertiesLine,
		truncated: spec.truncated ?? false,
	};
}

export function buildChildItemSpecs(
	resolvedChildren: Map<string, ResolvedPlanChildItem>,
	orderedIds: string[],
	opts: BuildChildItemSpecsOptions,
): { items: Array<ChildItemSpec & { truncated: boolean }>; omittedCount: number; totalCount: number } {
	const perChildMaxBytes = clampMaxBytes(opts.perChildMaxBytes);
	const globalMaxBytes = clampMaxBytes(opts.globalMaxBytes);
	const items: Array<ChildItemSpec & { truncated: boolean }> = [];
	const totalCount = orderedIds.length;

	let usedBytes = 0;
	for (const childItemId of orderedIds) {
		const childItem = resolvedChildren.get(childItemId);
		if (!childItem) continue;

		const truncatedBody = safeTruncateUtf8(childItem.body, perChildMaxBytes);
		const nextItem = {
			id: childItem.id,
			title: extractChildTitle(childItem.body),
			body: truncatedBody.text,
			properties: childItem.properties,
			truncated: truncatedBody.truncated,
		};
		const nextSize = Buffer.byteLength(JSON.stringify(nextItem), "utf8");
		if (usedBytes + nextSize > globalMaxBytes) {
			break;
		}

		items.push(nextItem);
		usedBytes += nextSize;
	}

	return {
		items,
		omittedCount: Math.max(totalCount - items.length, 0),
		totalCount,
	};
}
