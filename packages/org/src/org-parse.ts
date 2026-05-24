import { executeOrg } from "@oh-my-pi/pi-natives";

export interface OrgHeading {
	level: number;
	title: string;
	tags: string[];
	properties: Record<string, string>;
	body: string;
	children: OrgHeading[];
}

export async function orgToMarkdown(org: string): Promise<string> {
	const result = await executeOrg({ command: "toMarkdown", source: org });
	return (result.output as { markdown: string }).markdown;
}

export async function orgToPlainText(org: string): Promise<string> {
	const result = await executeOrg({ command: "toPlainText", source: org });
	return (result.output as { text: string }).text;
}

export function extractOrgKeywords(org: string): Record<string, string> {
	if (!org.trim()) return {};
	const result: Record<string, string> = {};
	for (const line of org.split(/\r?\n/)) {
		if (!line.startsWith("#+")) break;
		const match = /^#\+([A-Za-z_]+):\s*(.*)$/.exec(line);
		if (match) result[match[1]!.toLowerCase()] = match[2]!.trim();
	}
	return result;
}

export function parseOrgHeadings(org: string): OrgHeading[] {
	const lines = org.split(/\r?\n/);
	const headings: OrgHeading[] = [];
	const stack: OrgHeading[] = [];
	for (const line of lines) {
		const m = /^(\*+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const heading: OrgHeading = {
			level: m[1]!.length,
			title: m[2]!.trim(),
			tags: [],
			properties: {},
			body: "",
			children: [],
		};
		while (stack.length && stack[stack.length - 1]!.level >= heading.level) stack.pop();
		if (stack.length) stack[stack.length - 1]!.children.push(heading);
		else headings.push(heading);
		stack.push(heading);
	}
	return headings;
}
