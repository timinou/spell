import { DEFAULT_TODO_KEYWORDS, readOrgFile } from "@spell/pi-org";
import type { LoopSnapshot } from "../types";

function mapLoopStateToOrgState(state: LoopSnapshot["state"]): string {
	switch (state) {
		case "complete":
			return "DONE";
		case "paused":
		case "failed":
			return "BLOCKED";
		case "cancelled":
		case "killed":
			return "DONE";
		default:
			return "DOING";
	}
}

function getLoopOrgPath(cwd: string, loopId: string): string {
	return `${cwd}/!tasks/projects/${loopId}.org`;
}

function renderLoopBody(loop: LoopSnapshot): string {
	const lines = [
		`#+TITLE: Loop ${loop.name}`,
		`#+STATE: ${mapLoopStateToOrgState(loop.state)}`,
		`#+CUSTOM_ID: ${loop.orgItemId}`,
		"#+LAYER: backend",
		`#+LOOP_STATE: ${loop.state}`,
		`#+ITERATION: ${loop.iteration}`,
		`#+MAX_ITERATIONS: ${loop.maxIterations}`,
		`#+DEPTH: ${loop.depth}`,
		`#+PARENT_LOOP: ${loop.parentLoopId ?? ""}`,
		`#+LAST_GATE_OUTCOME: ${loop.gateResults.at(-1)?.outcome ?? ""}`,
		`#+LOOP_CHILDREN: ${loop.childLoopIds.join(",")}`,
		"",
		loop.lastSummary ?? "",
		loop.taskContent ?? "",
	];
	return `${lines.join("\n").trimEnd()}\n`;
}

export async function syncLoopOrgItem(cwd: string, loop: LoopSnapshot): Promise<string> {
	const filePath = getLoopOrgPath(cwd, loop.id);
	await Bun.write(filePath, renderLoopBody(loop));
	return filePath;
}

export async function readLoopOrgState(
	cwd: string,
	loopId: string,
): Promise<{ state?: string; body?: string } | undefined> {
	const filePath = getLoopOrgPath(cwd, loopId);
	const items = await readOrgFile({
		filePath,
		category: "projects",
		dir: "projects",
		todoKeywords: [...DEFAULT_TODO_KEYWORDS],
		includeBody: true,
	});
	const item = items[0];
	if (!item) return undefined;
	return { state: item.properties.LOOP_STATE, body: item.body };
}
