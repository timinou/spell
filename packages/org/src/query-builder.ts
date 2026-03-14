/**
 * Structured org-ql query builder.
 *
 * Translates TypeScript filter objects into org-ql sexp strings
 * for use with the Emacs org-ql bridge.
 *
 * Simple queries (state, priority, tags, text) can be evaluated
 * TS-side without Emacs. Advanced predicates (date, clocked, effort,
 * numeric property comparison) require org-ql via Emacs.
 */

export interface OrgQlFilter {
	todo?: string[];
	tags?: string[];
	priority?: { op: ">=" | "<=" | "="; value: string };
	properties?: Array<{ key: string; value: string; op?: "=" | ">" | "<" }>;
	dateRange?: { from?: string; to?: string };
	clocked?: { on?: string; from?: string };
	effort?: { op: "<=" | ">=" | "="; value: string };
	text?: string;
	and?: OrgQlFilter[];
	or?: OrgQlFilter[];
	not?: OrgQlFilter;
}

/**
 * Convert a filter object to an org-ql sexp string.
 * Returns a parseable Emacs Lisp sexp.
 */
export function buildOrgQlSexp(filter: OrgQlFilter): string {
	const parts: string[] = [];

	if (filter.todo && filter.todo.length > 0) {
		const states = filter.todo.map(s => `"${s}"`).join(" ");
		parts.push(`(todo ${states})`);
	}

	if (filter.tags && filter.tags.length > 0) {
		for (const tag of filter.tags) {
			parts.push(`(tags "${tag}")`);
		}
	}

	if (filter.priority) {
		const { op, value } = filter.priority;
		parts.push(`(priority ${op} "${value}")`);
	}

	if (filter.properties) {
		for (const prop of filter.properties) {
			// org-ql (property) does string matching; numeric ops need custom predicate.
			// Numeric comparison defers to Emacs-side evaluation (requiresEmacs returns true).
			parts.push(`(property "${prop.key}" "${prop.value}")`);
		}
	}

	if (filter.dateRange) {
		const { from, to } = filter.dateRange;
		const fromPart = from ? ` :from "${from}"` : "";
		const toPart = to ? ` :to "${to}"` : "";
		parts.push(`(ts${fromPart}${toPart})`);
	}

	if (filter.clocked) {
		const { on, from: fromDate } = filter.clocked;
		if (on) parts.push(`(clocked :on "${on}")`);
		else if (fromDate) parts.push(`(clocked :from "${fromDate}")`);
	}

	if (filter.effort) {
		const { op, value } = filter.effort;
		parts.push(`(effort ${op} "${value}")`);
	}

	if (filter.text) {
		parts.push(`(regexp "${filter.text.replace(/"/g, '\\"')}")`);
	}

	if (filter.and && filter.and.length > 0) {
		const inner = filter.and.map(buildOrgQlSexp).join(" ");
		parts.push(`(and ${inner})`);
	}

	if (filter.or && filter.or.length > 0) {
		const inner = filter.or.map(buildOrgQlSexp).join(" ");
		parts.push(`(or ${inner})`);
	}

	if (filter.not) {
		parts.push(`(not ${buildOrgQlSexp(filter.not)})`);
	}

	if (parts.length === 0) return "(default)";
	if (parts.length === 1) return parts[0]!;
	return `(and ${parts.join(" ")})`;
}

/**
 * Determine if a filter requires Emacs (org-ql) or can be
 * evaluated TS-side via applyFilter.
 *
 * Simple (TS-side): todo, tags, text, priority (string match)
 * Advanced (needs Emacs): dateRange, clocked, effort, numeric property ops
 */
export function requiresEmacs(filter: OrgQlFilter): boolean {
	if (filter.dateRange || filter.clocked || filter.effort) return true;
	if (filter.properties?.some(p => p.op && p.op !== "=")) return true;
	if (filter.and?.some(requiresEmacs)) return true;
	if (filter.or?.some(requiresEmacs)) return true;
	if (filter.not && requiresEmacs(filter.not)) return true;
	return false;
}

/**
 * Parse a keyword-style query string into an OrgQlFilter.
 * Format: `todo:DOING tags:auth,backend priority:>=B`
 */
export function parseKeywordQuery(input: string): OrgQlFilter {
	const filter: OrgQlFilter = {};
	const tokens = input.trim().split(/\s+/);

	for (const token of tokens) {
		if (token.startsWith("todo:")) {
			filter.todo = token.slice(5).split(",").filter(Boolean);
		} else if (token.startsWith("tags:")) {
			filter.tags = token.slice(5).split(",").filter(Boolean);
		} else if (token.startsWith("priority:")) {
			const val = token.slice(9);
			const match = val.match(/^(>=|<=|=)?([A-C#])$/);
			if (match) {
				// match[1] may be undefined when no op prefix is given; default to '='
				const rawOp = match[1] ?? "=";
				const op = rawOp as ">=" | "<=" | "=";
				filter.priority = { op, value: match[2]! };
			}
		} else if (token.startsWith("property:")) {
			const [key, value] = token.slice(9).split("=", 2);
			if (key && value !== undefined) {
				filter.properties = [...(filter.properties ?? []), { key, value }];
			}
		}
	}

	return filter;
}
