import type { LoopSnapshot } from "../types";

export function collectKillTree(rootLoopId: string, loops: LoopSnapshot[]): string[] {
	const byParent = new Map<string, string[]>();
	for (const loop of loops) {
		if (!loop.parentLoopId) continue;
		const children = byParent.get(loop.parentLoopId) ?? [];
		children.push(loop.id);
		byParent.set(loop.parentLoopId, children);
	}
	const ordered: string[] = [];
	const visit = (loopId: string): void => {
		ordered.push(loopId);
		for (const childId of byParent.get(loopId) ?? []) {
			visit(childId);
		}
	};
	visit(rootLoopId);
	return ordered;
}
