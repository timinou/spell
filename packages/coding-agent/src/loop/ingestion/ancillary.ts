import { isEnoent } from "@spell/pi-utils";

export async function findMissingGuidelineDomains(cwd: string, domains: string[]): Promise<string[]> {
	const missing: string[] = [];
	for (const domain of domains) {
		try {
			await Bun.file(`${cwd}/packages/coding-agent/src/loop/domains/prompts/${domain}.md`).text();
		} catch (error) {
			if (isEnoent(error)) {
				missing.push(domain);
				continue;
			}
			throw error;
		}
	}
	return missing;
}
