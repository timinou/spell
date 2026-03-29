import * as path from "node:path";
import { $ } from "bun";

export function formatLoopCheckpointMessage(loopId: string, iteration: number): string {
	return `loop(${loopId}): iteration ${iteration} checkpoint`;
}

export async function createLoopCheckpoint(
	cwd: string,
	loopId: string,
	iteration: number,
	files: string[],
): Promise<string> {
	const relativeFiles = files.map(file => path.relative(cwd, file));
	await $`git add ${relativeFiles}`.cwd(cwd).quiet().nothrow();
	const message = formatLoopCheckpointMessage(loopId, iteration);
	await $`git commit -m ${message}`.cwd(cwd).quiet().nothrow();
	return message;
}
