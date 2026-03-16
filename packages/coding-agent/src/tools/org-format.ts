/**
 * org-format.ts — Budget-based org-mode text formatter for org tool output.
 *
 * Converts raw OrgItem results into org-mode text with a byte budget so
 * query results never blow up the LLM context window.
 */

import type { OrgItem } from "@oh-my-pi/pi-org";

// ---------------------------------------------------------------------------
// Budget constants (~20k token target = ~80KB)
// ---------------------------------------------------------------------------

const MAX_BYTES = 80 * 1024;
/** Fraction of budget allocated to items rendered with bodies. */
const BODY_BUDGET_RATIO = 0.5;
/** Fraction of budget allocated to header-only items (cumulative). */
const HEADER_BUDGET_RATIO = 0.8;
/** Per-item body byte cap before truncation notice is appended. */
const MAX_BODY_PER_ITEM = 2 * 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a single OrgItem as org-mode text.
 *
 * @param item          The item to render.
 * @param includeBody   Whether to append the body text.
 * @param maxBodyBytes  Max bytes for the body before truncation. Use Infinity
 *                      for no limit (e.g. single-item `org get`).
 */
export function renderItemOrg(item: OrgItem, includeBody: boolean, maxBodyBytes: number): string {
	const tags = item.properties.TAGS ? `  :${item.properties.TAGS}:` : "";
	const heading = `* ${item.state} ${item.title}${tags}`;

	// Build properties drawer. CUSTOM_ID is always first, then all other
	// properties from the item's properties map.
	const extraProps = Object.entries(item.properties)
		.filter(([k]) => k !== "TAGS") // TAGS rendered on heading line
		.map(([k, v]) => `:${k}: ${v}`)
		.join("\n");
	const drawerBody = extraProps ? `:CUSTOM_ID: ${item.id}\n${extraProps}` : `:CUSTOM_ID: ${item.id}`;
	const drawer = `:PROPERTIES:\n${drawerBody}\n:END:`;

	if (!includeBody || !item.body) return `${heading}\n${drawer}`;

	let body = item.body.trim();
	if (maxBodyBytes !== Infinity && Buffer.byteLength(body) > maxBodyBytes) {
		// Slice by bytes. String slicing by index may over-cut for multi-byte
		// chars, but the truncation notice makes that acceptable.
		const truncated = Buffer.from(body).subarray(0, maxBodyBytes).toString("utf8");
		body = `${truncated}\n[body truncated, use \`org get ${item.id}\` for full content]`;
	}

	return `${heading}\n${drawer}\n\n${body}`;
}

/**
 * Format a query result set as org-mode text, respecting the byte budget.
 *
 * Strategy:
 *   Phase 1 (0–50% of budget): Items with their bodies (each body capped at 2KB).
 *   Phase 2 (50–80% of budget): Remaining items as header + properties only.
 *   Phase 3 (80%+): Stop. Append a summary line with counts.
 */
export function formatOrgQueryResult(items: OrgItem[], total: number): string {
	if (items.length === 0) return "No items found.";

	const parts: string[] = [];
	let used = 0;
	let withBody = 0;
	let headersOnly = 0;

	// Phase 1: render with bodies
	for (const item of items) {
		if (used >= MAX_BYTES * BODY_BUDGET_RATIO) break;
		const rendered = renderItemOrg(item, true, MAX_BODY_PER_ITEM);
		const size = Buffer.byteLength(rendered);
		if (used + size > MAX_BYTES * BODY_BUDGET_RATIO) break;
		parts.push(rendered);
		used += size;
		withBody++;
	}

	// Phase 2: headers only for remaining items
	for (let i = withBody; i < items.length; i++) {
		if (used >= MAX_BYTES * HEADER_BUDGET_RATIO) break;
		const rendered = renderItemOrg(items[i]!, false, 0);
		const size = Buffer.byteLength(rendered);
		if (used + size > MAX_BYTES * HEADER_BUDGET_RATIO) break;
		parts.push(rendered);
		used += size;
		headersOnly++;
	}

	const hidden = total - withBody - headersOnly;
	if (hidden > 0) {
		parts.push(
			`[Showing ${withBody + headersOnly} of ${total} items. ${withBody} with body, ${headersOnly} headers only, ${hidden} hidden. Narrow with category/state filters.]`,
		);
	}

	return parts.join("\n\n");
}
