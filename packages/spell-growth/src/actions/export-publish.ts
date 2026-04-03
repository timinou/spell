import * as path from "node:path";
import type { GrowthPublicationExportInput } from "./types";

export interface GrowthPublicationExportResult {
	cmsPath: string;
	draftPaths: string[];
}

export function slugifyTitle(title: string): string {
	return title
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function validateItem(item: GrowthPublicationExportInput["items"][number]): void {
	if (!item.title.trim() || !item.body.trim() || !item.canonicalUrl.trim()) {
		throw new Error(`Publication item ${item.id} is missing required fields`);
	}
}

export async function exportPublicationArtifacts(
	input: GrowthPublicationExportInput,
): Promise<GrowthPublicationExportResult> {
	for (const item of input.items) {
		validateItem(item);
	}
	const draftPaths: string[] = [];
	const cmsPath = path.join(input.cmsOutboxDir, "publication-export.json");
	const cmsPayload = input.items.map(item => ({
		id: item.id,
		title: item.title,
		slug: slugifyTitle(item.title),
		summary: item.summary,
		canonicalUrl: item.canonicalUrl,
		publishedAt: item.publishedAt,
	}));
	await Bun.write(cmsPath, JSON.stringify(cmsPayload, null, 2));
	for (const item of input.items) {
		const slug = slugifyTitle(item.title);
		const draftPath = path.join(input.repoDraftDir, `${slug}.md`);
		await Bun.write(
			draftPath,
			`---\ntitle: ${item.title}\nslug: ${slug}\ncanonicalUrl: ${item.canonicalUrl}\n---\n\n${item.body}\n`,
		);
		draftPaths.push(draftPath);
	}
	return { cmsPath, draftPaths };
}
