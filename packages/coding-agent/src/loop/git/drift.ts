import { isEnoent } from "@spell/pi-utils";
import { hashTaskContent } from "../hash";

export type DriftSnapshot = Record<string, string>;

export async function snapshotSpecFiles(paths: string[]): Promise<DriftSnapshot> {
	const snapshot: DriftSnapshot = {};
	for (const filePath of paths) {
		try {
			snapshot[filePath] = hashTaskContent(await Bun.file(filePath).text());
		} catch (error) {
			if (isEnoent(error)) {
				snapshot[filePath] = "missing";
				continue;
			}
			throw error;
		}
	}
	return snapshot;
}

export async function detectSpecDrift(previous: DriftSnapshot): Promise<string[]> {
	const changed: string[] = [];
	for (const [filePath, hash] of Object.entries(previous)) {
		const current = await snapshotSpecFiles([filePath]);
		if (current[filePath] !== hash) {
			changed.push(filePath);
		}
	}
	return changed;
}
