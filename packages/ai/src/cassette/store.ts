import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function loadCassette(dir: string, fingerprint: string): Promise<unknown | null> {
	const filePath = path.join(dir, fingerprint.replace("sha256:", "") + ".json");
	try {
		const text = await Bun.file(filePath).text();
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export async function saveCassette(dir: string, cassette: unknown): Promise<void> {
	const filePath = path.join(dir, (cassette as { fingerprint: string }).fingerprint.replace("sha256:", "") + ".json");
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(filePath, JSON.stringify(cassette, null, "\t") + "\n");
}
