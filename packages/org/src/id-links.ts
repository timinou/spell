/**
 * Extract org CUSTOM_ID references from [[id:...]] links in body text.
 *
 * Returns unique IDs in first-seen order.
 */
export function extractIdLinks(body: string): string[] {
	const matches = body.matchAll(/\[\[id:([A-Z]+-\d+(?:-[a-z0-9-]+)?)\]\]/g);
	const ids = new Set<string>();
	for (const match of matches) {
		const id = match[1];
		if (id) ids.add(id);
	}
	return [...ids];
}
