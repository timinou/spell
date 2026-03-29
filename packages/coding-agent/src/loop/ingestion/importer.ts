import * as path from "node:path";
import type { ParsedSpecFile } from "./parser";

export async function importParsedSpecs(cwd: string, parsed: ParsedSpecFile[], sourceRoot: string): Promise<string[]> {
	const written: string[] = [];
	for (const file of parsed) {
		const relative = path.relative(sourceRoot, file.path);
		const target = path.join(cwd, "!tasks", "drafts", "imported-specs", relative);
		await Bun.write(target, file.content);
		written.push(target);
	}
	return written;
}
