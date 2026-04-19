import * as path from "node:path";

export type MutableDagRemovalMode = "cascade" | "orphan";

export interface MutableDagNode<T> {
	data: T;
	dependsOn: string[];
}

interface MutableDagState<T> {
	order: string[];
	nodesById: Map<string, T>;
	dependsOnById: Map<string, string[]>;
	dependentsById: Map<string, string[]>;
}

function dedupeValues(values: string[] | undefined): string[] {
	if (!values?.length) return [];
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		unique.push(value);
	}
	return unique;
}

function cloneState<T>(state: MutableDagState<T>): MutableDagState<T> {
	return {
		order: [...state.order],
		nodesById: new Map(state.nodesById),
		dependsOnById: new Map(Array.from(state.dependsOnById, ([id, deps]) => [id, [...deps]])),
		dependentsById: new Map(Array.from(state.dependentsById, ([id, deps]) => [id, [...deps]])),
	};
}

function buildState<T>(entries: Array<[string, T, string[]]>): MutableDagState<T> {
	const order: string[] = [];
	const nodesById = new Map<string, T>();
	const dependsOnById = new Map<string, string[]>();
	const dependentsById = new Map<string, string[]>();
	const ids = new Set<string>();

	for (const [id, data, dependsOn] of entries) {
		if (ids.has(id)) {
			throw new Error(`MutableDag duplicate node: ${id}`);
		}
		ids.add(id);
		order.push(id);
		nodesById.set(id, data);
		dependsOnById.set(id, dependsOn);
		dependentsById.set(id, []);
	}

	for (const [id, , dependsOn] of entries) {
		for (const dependencyId of dependsOn) {
			if (dependencyId === id) {
				throw new Error(`MutableDag self-dependency rejected: ${id}`);
			}
			if (!nodesById.has(dependencyId)) {
				throw new Error(`MutableDag missing dependency: ${dependencyId}`);
			}
			dependentsById.get(dependencyId)?.push(id);
		}
	}

	return { order, nodesById, dependsOnById, dependentsById };
}

function topologicalOrderFromState<T>(state: MutableDagState<T>): string[] {
	const inDegree = new Map<string, number>();
	for (const id of state.order) {
		inDegree.set(id, state.dependsOnById.get(id)?.length ?? 0);
	}

	const queue: string[] = [];
	for (const id of state.order) {
		if ((inDegree.get(id) ?? 0) === 0) queue.push(id);
	}

	const ordered: string[] = [];
	for (let index = 0; index < queue.length; index++) {
		const currentId = queue[index];
		ordered.push(currentId);
		for (const dependentId of state.dependentsById.get(currentId) ?? []) {
			const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
			inDegree.set(dependentId, nextDegree);
			if (nextDegree === 0) queue.push(dependentId);
		}
	}

	if (ordered.length !== state.order.length) {
		throw new Error("MutableDag contains dependency cycles");
	}
	return ordered;
}

function hasTrailingSeparator(value: string): boolean {
	return value.endsWith("/") || value.endsWith("\\");
}

function normalizeFilesDepPath(filePath: string): string {
	const resolved = path.resolve(filePath);
	const root = path.parse(resolved).root;
	let normalized = resolved;
	while (normalized.length > root.length && hasTrailingSeparator(normalized)) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

function isSubtreePath(ancestorPath: string, descendantPath: string): boolean {
	const relative = path.relative(ancestorPath, descendantPath);
	return (
		relative.length > 0 &&
		relative !== "." &&
		!relative.startsWith(`..${path.sep}`) &&
		relative !== ".." &&
		!path.isAbsolute(relative)
	);
}

export function findOverlappingFilesDep(left: string[] | undefined, right: string[] | undefined): string | null {
	const normalizedLeft = (left ?? [])
		.filter(Boolean)
		.map(filePath => ({ original: filePath, normalized: normalizeFilesDepPath(filePath) }));
	const normalizedRight = (right ?? [])
		.filter(Boolean)
		.map(filePath => ({ original: filePath, normalized: normalizeFilesDepPath(filePath) }));
	if (normalizedLeft.length === 0 || normalizedRight.length === 0) return null;
	for (const leftPath of normalizedLeft) {
		for (const rightPath of normalizedRight) {
			if (leftPath.normalized === rightPath.normalized) return rightPath.original || leftPath.original;
			if (isSubtreePath(leftPath.normalized, rightPath.normalized)) return rightPath.original;
			if (isSubtreePath(rightPath.normalized, leftPath.normalized)) return leftPath.original;
		}
	}
	return null;
}

function filesDepsOverlap(left: string[] | undefined, right: string[] | undefined): boolean {
	return findOverlappingFilesDep(left, right) !== null;
}

export class MutableDag<T extends { filesDeps?: string[] }> {
	#state: MutableDagState<T>;

	constructor(entries?: Array<[string, T, string[]?]>) {
		const normalizedEntries =
			entries?.map(([id, data, dependsOn]) => [id, data, dedupeValues(dependsOn)] as [string, T, string[]]) ?? [];
		this.#state = buildState(normalizedEntries);
	}

	hasNode(id: string): boolean {
		return this.#state.nodesById.has(id);
	}

	getNode(id: string): T | undefined {
		return this.#state.nodesById.get(id);
	}

	getDependencies(id: string): string[] {
		return [...(this.#state.dependsOnById.get(id) ?? [])];
	}

	getDependents(id: string): string[] {
		return [...(this.#state.dependentsById.get(id) ?? [])];
	}

	addNode(id: string, data: T, dependsOn: string[] = []): void {
		this.#applyMutation(state => {
			if (state.nodesById.has(id)) throw new Error(`MutableDag duplicate node: ${id}`);
			const nextDependsOn = dedupeValues(dependsOn);
			for (const dependencyId of nextDependsOn) {
				if (dependencyId === id) throw new Error(`MutableDag self-dependency rejected: ${id}`);
				if (!state.nodesById.has(dependencyId)) throw new Error(`MutableDag missing dependency: ${dependencyId}`);
			}
			state.order.push(id);
			state.nodesById.set(id, data);
			state.dependsOnById.set(id, nextDependsOn);
			state.dependentsById.set(id, []);
			for (const dependencyId of nextDependsOn) {
				state.dependentsById.get(dependencyId)?.push(id);
			}
			this.#assertAcyclic(state);
		});
	}

	setNode(id: string, data: T): void {
		this.#applyMutation(state => {
			if (!state.nodesById.has(id)) throw new Error(`MutableDag missing node: ${id}`);
			state.nodesById.set(id, data);
		});
	}

	setDependencies(id: string, dependsOn: string[]): void {
		this.#applyMutation(state => {
			if (!state.nodesById.has(id)) throw new Error(`MutableDag missing node: ${id}`);
			const nextDependsOn = dedupeValues(dependsOn);
			for (const dependencyId of nextDependsOn) {
				if (dependencyId === id) throw new Error(`MutableDag self-dependency rejected: ${id}`);
				if (!state.nodesById.has(dependencyId)) throw new Error(`MutableDag missing dependency: ${dependencyId}`);
			}
			const previousDependsOn = state.dependsOnById.get(id) ?? [];
			for (const dependencyId of previousDependsOn) {
				const dependents = state.dependentsById.get(dependencyId);
				if (dependents)
					state.dependentsById.set(
						dependencyId,
						dependents.filter(dependentId => dependentId !== id),
					);
			}
			state.dependsOnById.set(id, nextDependsOn);
			for (const dependencyId of nextDependsOn) {
				state.dependentsById.get(dependencyId)?.push(id);
			}
			this.#assertAcyclic(state);
		});
	}

	addEdge(fromId: string, toId: string): void {
		this.#applyMutation(state => {
			const fromNodeExists = state.nodesById.has(fromId);
			const toNodeExists = state.nodesById.has(toId);
			if (!fromNodeExists || !toNodeExists)
				throw new Error(`MutableDag missing node: ${!fromNodeExists ? fromId : toId}`);
			if (fromId === toId) throw new Error(`MutableDag self-dependency rejected: ${fromId}`);
			const dependsOn = state.dependsOnById.get(toId) ?? [];
			if (dependsOn.includes(fromId)) return;
			dependsOn.push(fromId);
			state.dependsOnById.set(toId, dependsOn);
			state.dependentsById.get(fromId)?.push(toId);
			this.#assertAcyclic(state);
		});
	}

	removeEdge(fromId: string, toId: string): void {
		this.#applyMutation(state => {
			if (!state.nodesById.has(fromId) || !state.nodesById.has(toId)) {
				throw new Error(`MutableDag missing node: ${!state.nodesById.has(fromId) ? fromId : toId}`);
			}
			const dependsOn = state.dependsOnById.get(toId);
			if (!dependsOn?.includes(fromId)) return;
			state.dependsOnById.set(
				toId,
				dependsOn.filter(dependencyId => dependencyId !== fromId),
			);
			const dependents = state.dependentsById.get(fromId) ?? [];
			state.dependentsById.set(
				fromId,
				dependents.filter(dependentId => dependentId !== toId),
			);
		});
	}

	removeNode(id: string, mode: MutableDagRemovalMode = "cascade"): void {
		this.#applyMutation(state => {
			if (!state.nodesById.has(id)) throw new Error(`MutableDag missing node: ${id}`);
			if (mode === "cascade") {
				const toRemove = new Set<string>([id]);
				const queue = [id];
				while (queue.length > 0) {
					const currentId = queue.shift();
					if (!currentId) continue;
					for (const dependentId of state.dependentsById.get(currentId) ?? []) {
						if (toRemove.has(dependentId)) continue;
						toRemove.add(dependentId);
						queue.push(dependentId);
					}
				}
				this.#deleteNodes(state, toRemove);
				return;
			}

			const directDependents = [...(state.dependentsById.get(id) ?? [])];
			for (const dependentId of directDependents) {
				const dependsOn = state.dependsOnById.get(dependentId) ?? [];
				state.dependsOnById.set(
					dependentId,
					dependsOn.filter(dependencyId => dependencyId !== id),
				);
			}
			this.#deleteNodes(state, new Set([id]));
			this.#assertAcyclic(state);
		});
	}

	getReadyNodeIds(completed: Set<string> = new Set<string>()): string[] {
		const ready: string[] = [];
		for (const id of this.#state.order) {
			if (completed.has(id)) continue;
			const deps = this.#state.dependsOnById.get(id) ?? [];
			if (deps.every(dep => completed.has(dep))) ready.push(id);
		}
		return ready;
	}

	topologicalOrder(): string[] {
		return topologicalOrderFromState(this.#state);
	}

	splitIntoComponents(): Array<MutableDag<T>> {
		if (this.#state.order.length <= 1) return [this.clone()];
		const visited = new Set<string>();
		const components: Array<MutableDag<T>> = [];
		for (const id of this.#state.order) {
			if (visited.has(id)) continue;
			const queue = [id];
			const componentIds: string[] = [];
			visited.add(id);
			while (queue.length > 0) {
				const currentId = queue.shift();
				if (!currentId) continue;
				componentIds.push(currentId);
				for (const neighborId of [
					...(this.#state.dependsOnById.get(currentId) ?? []),
					...(this.#state.dependentsById.get(currentId) ?? []),
				]) {
					if (visited.has(neighborId)) continue;
					visited.add(neighborId);
					queue.push(neighborId);
				}
			}
			components.push(this.#subgraph(componentIds));
		}
		return components;
	}

	getOverlappingNodeIds(id: string): string[] {
		const filesDeps = this.#state.nodesById.get(id)?.filesDeps;
		if (!filesDeps?.length) return [];
		return this.#state.order.filter(otherId => otherId !== id && this.hasFileOverlap(id, otherId));
	}

	hasFileOverlap(leftId: string, rightId: string): boolean {
		return filesDepsOverlap(
			this.#state.nodesById.get(leftId)?.filesDeps,
			this.#state.nodesById.get(rightId)?.filesDeps,
		);
	}

	clone(): MutableDag<T> {
		return new MutableDag(
			Array.from(this.#state.order, id => [
				id,
				this.#state.nodesById.get(id) as T,
				this.#state.dependsOnById.get(id) ?? [],
			]),
		);
	}

	#subgraph(ids: string[]): MutableDag<T> {
		return new MutableDag(
			ids.map(id => [id, this.#state.nodesById.get(id) as T, this.#state.dependsOnById.get(id) ?? []]),
		);
	}

	#deleteNodes(state: MutableDagState<T>, ids: Set<string>): void {
		for (const id of ids) {
			for (const dependencyId of state.dependsOnById.get(id) ?? []) {
				const dependents = state.dependentsById.get(dependencyId) ?? [];
				state.dependentsById.set(
					dependencyId,
					dependents.filter(dependentId => dependentId !== id),
				);
			}
			for (const dependentId of state.dependentsById.get(id) ?? []) {
				const dependsOn = state.dependsOnById.get(dependentId) ?? [];
				state.dependsOnById.set(
					dependentId,
					dependsOn.filter(dependencyId => dependencyId !== id),
				);
			}
			state.nodesById.delete(id);
			state.dependsOnById.delete(id);
			state.dependentsById.delete(id);
		}
		state.order = state.order.filter(id => !ids.has(id));
	}

	#applyMutation(mutator: (state: MutableDagState<T>) => void): void {
		const nextState = cloneState(this.#state);
		mutator(nextState);
		this.#state = nextState;
	}

	#assertAcyclic(state: MutableDagState<T>): void {
		topologicalOrderFromState(state);
	}
}
