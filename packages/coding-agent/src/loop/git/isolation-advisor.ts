export function recommendWorktreeIsolation(pathsA: string[], pathsB: string[]): boolean {
	const setA = new Set(pathsA);
	for (const entry of pathsB) {
		if (setA.has(entry)) return true;
	}
	return false;
}
