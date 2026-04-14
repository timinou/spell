export interface RewriteSubOutlineIdsResult {
	body: string;
	rewrites: Map<string, string>;
}

const CUSTOM_ID_LINE_RE = /^(\s*:CUSTOM_ID:\s+)(\S+)(\s*)$/;
const DEPENDS_LINE_RE = /^(\s*:DEPENDS:\s+)(.+?)(\s*)$/;

function buildPrefixedId(parentId: string, localId: string): string {
	return `${parentId}::${localId}`;
}

function collectRewriteMap(parentId: string, body: string): Map<string, string> {
	const rewrites = new Map<string, string>();
	const prefixedPrefix = `${parentId}::`;

	for (const line of body.split("\n")) {
		const match = CUSTOM_ID_LINE_RE.exec(line);
		if (!match) continue;
		const customId = match[2];
		if (!customId) continue;
		if (customId.startsWith(prefixedPrefix)) continue;
		if (customId.includes("::")) continue;
		rewrites.set(customId, buildPrefixedId(parentId, customId));
	}

	return rewrites;
}

function rewriteDependsValue(dependsValue: string, rewrites: Map<string, string>): string {
	const tokens = dependsValue.split(/(\s+)/);
	return tokens.map(token => rewrites.get(token) ?? token).join("");
}

export function rewriteSubOutlineIds(parentId: string, body: string): RewriteSubOutlineIdsResult {
	if (!body) {
		return { body, rewrites: new Map() };
	}

	const rewrites = collectRewriteMap(parentId, body);
	if (rewrites.size === 0) {
		return { body, rewrites };
	}

	const rewrittenBody = body
		.split("\n")
		.map(line => {
			const customIdMatch = CUSTOM_ID_LINE_RE.exec(line);
			if (customIdMatch) {
				const nextId = rewrites.get(customIdMatch[2]);
				if (!nextId) return line;
				return `${customIdMatch[1]}${nextId}${customIdMatch[3]}`;
			}

			const dependsMatch = DEPENDS_LINE_RE.exec(line);
			if (!dependsMatch) return line;
			return `${dependsMatch[1]}${rewriteDependsValue(dependsMatch[2], rewrites)}${dependsMatch[3]}`;
		})
		.join("\n");

	return {
		body: rewrittenBody,
		rewrites,
	};
}
