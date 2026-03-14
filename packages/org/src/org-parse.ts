import { toMdast } from "hast-util-to-mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { toString as orgNodeToString } from "orgast-util-to-string";
import { parse } from "uniorg-parse/lib/parser";
import { orgToHast } from "uniorg-rehype/lib/org-to-hast";

export interface OrgHeading {
	level: number;
	title: string;
	tags: string[];
	properties: Record<string, string>;
	body: string;
	children: OrgHeading[];
}

/** Convert org-mode text to CommonMark markdown. */
export function orgToMarkdown(org: string): string {
	const orgAst = parse(org);
	const hast = orgToHast(orgAst);
	const mdast = toMdast(hast);
	return toMarkdown(mdast);
}

/** Convert org-mode text to plain text (no markup). For token counting, search. */
export function orgToPlainText(org: string): string {
	return orgNodeToString(parse(org));
}

/** Extract #+KEYWORD frontmatter from org text. Returns Record<lowercase-key, value>. */
export function extractOrgKeywords(org: string): Record<string, string> {
	if (!org.trim()) return {};

	const orgData = parse(org) as unknown as {
		type: "org-data";
		children: unknown[];
	};

	const result: Record<string, string> = {};
	for (const child of orgData.children) {
		const node = child as { type: string; key?: string; value?: string };
		// Stop at the first heading or section — keywords are preamble-only
		if (node.type === "section" || node.type === "headline") break;
		if (node.type === "keyword" && node.key !== undefined && node.value !== undefined) {
			result[node.key.toLowerCase()] = node.value;
		}
	}
	return result;
}

// Internal AST node shape from uniorg — not exported.
type RawNode = {
	type: string;
	children?: RawNode[];
	level?: number;
	tags?: string[];
	rawValue?: string;
	key?: string;
	value?: string;
};

function processSectionNode(section: RawNode): OrgHeading | null {
	const children = section.children ?? [];
	if (children.length === 0) return null;

	// The first child of a section is the headline node.
	const headlineNode = children[0];
	if (!headlineNode || headlineNode.type !== "headline") return null;

	const level = headlineNode.level ?? 0;
	const tags = headlineNode.tags ?? [];
	// rawValue is the clean heading text (no tags, no todo keyword).
	const title = headlineNode.rawValue ?? "";

	const properties: Record<string, string> = {};
	const bodyParts: string[] = [];
	const subHeadings: OrgHeading[] = [];

	for (let i = 1; i < children.length; i++) {
		const child = children[i]!;
		if (child.type === "property-drawer") {
			for (const prop of child.children ?? []) {
				if (prop.type === "node-property" && prop.key !== undefined && prop.value !== undefined) {
					properties[prop.key] = prop.value;
				}
			}
		} else if (child.type === "section") {
			// Sub-sections contain sub-headings.
			const sub = processSectionNode(child);
			if (sub !== null) subHeadings.push(sub);
		} else {
			// Paragraphs, src-blocks, etc. — collect as body text.
			const text = orgNodeToString(child as Parameters<typeof orgNodeToString>[0]);
			if (text) bodyParts.push(text);
		}
	}

	return {
		level,
		title,
		tags,
		properties,
		body: bodyParts.join(""),
		children: subHeadings,
	};
}

/** Parse org headings with full structure. */
export function parseOrgHeadings(org: string): OrgHeading[] {
	if (!org.trim()) return [];

	const orgData = parse(org) as unknown as RawNode;
	const headings: OrgHeading[] = [];

	// org-data.children = [keyword*, section*].
	// Each section wraps one headline plus its body and sub-sections.
	for (const child of orgData.children ?? []) {
		const node = child as RawNode;
		if (node.type === "section") {
			const heading = processSectionNode(node);
			if (heading !== null) headings.push(heading);
		}
	}

	return headings;
}
