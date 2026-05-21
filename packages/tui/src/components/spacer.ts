import type { Component, DirtyParent } from "../tui";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	#lines: number;
	#parent?: DirtyParent;

	constructor(lines: number = 1) {
		this.#lines = lines;
	}

	setParent(p: DirtyParent | undefined): void {
		this.#parent = p;
	}

	setLines(lines: number): void {
		this.#lines = lines;
		this.#parent?.markDirty();
	}

	invalidate(): void {
		this.#parent?.markDirty();
	}

	render(_width: number): string[] {
		const result: string[] = [];
		for (let i = 0; i < this.#lines; i++) {
			result.push("");
		}
		return result;
	}
}
