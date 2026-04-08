/**
 * Extract org CUSTOM_ID references from [[id:...]] links in body text.
 *
 * Returns unique IDs in first-seen order.
 */
export function extractIdLinks(body: string): string[] {
	const matches = body.matchAll(/\[\[id:([A-Z]+-\d+(?:-[a-z0-9-]+)?(?:::[a-z0-9-]+)?)\](?:\[[^\]]*\])?\]/g);
	const ids = new Set<string>();
	for (const match of matches) {
		const id = match[1];
		if (id) ids.add(id);
	}
	return [...ids];
}

/**
 * Parse a sub-outline CUSTOM_ID into parent and sub-slug components.
 * Returns null for top-level IDs (no :: separator).
 *
 * Example: "FEAT-001::define-types" -> { parentId: "FEAT-001", subSlug: "define-types" }
 */
export function parseSubOutlineId(id: string): { parentId: string; subSlug: string } | null {
	const sepIndex = id.indexOf("::");
	if (sepIndex === -1) return null;
	const parentId = id.slice(0, sepIndex);
	const subSlug = id.slice(sepIndex + 2);
	if (!parentId || !subSlug) return null;
	return { parentId, subSlug };
}
