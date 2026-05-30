import { describe, expect, it } from "bun:test";
import { type Component, Container } from "@spell/pi-tui";

class CountingComponent implements Component {
	#lines: string[];
	renderCount = 0;

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	setLines(lines: string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		this.renderCount++;
		return this.#lines;
	}
}

describe("Container dirty tracking", () => {
	describe("dirty flag lifecycle", () => {
		it("starts dirty (first render executes)", () => {
			const container = new Container();
			const child = new CountingComponent(["alpha"]);
			container.addChild(child);

			const lines = container.render(80);

			expect(lines).toEqual(["alpha"]);
			expect(child.renderCount).toBe(1);
		});

		it("clean after render", () => {
			const container = new Container();
			container.addChild(new CountingComponent(["alpha"]));

			const first = container.render(80);
			const second = container.render(80);

			expect(second).toBe(first);
		});

		it("addChild marks dirty", () => {
			const container = new Container();
			const firstChild = new CountingComponent(["alpha"]);
			const secondChild = new CountingComponent(["beta"]);
			container.addChild(firstChild);

			const before = container.render(80);
			container.addChild(secondChild);
			const after = container.render(80);

			expect(after).toEqual(["alpha", "beta"]);
			expect(after).not.toBe(before);
			expect(firstChild.renderCount).toBe(2);
			expect(secondChild.renderCount).toBe(1);
		});

		it("removeChild marks dirty", () => {
			const container = new Container();
			const firstChild = new CountingComponent(["alpha"]);
			const secondChild = new CountingComponent(["beta"]);
			container.addChild(firstChild);
			container.addChild(secondChild);

			const before = container.render(80);
			container.removeChild(secondChild);
			const after = container.render(80);

			expect(after).toEqual(["alpha"]);
			expect(after).not.toBe(before);
			expect(firstChild.renderCount).toBe(2);
			expect(secondChild.renderCount).toBe(1);
		});

		it("clear marks dirty", () => {
			const container = new Container();
			container.addChild(new CountingComponent(["alpha"]));
			container.addChild(new CountingComponent(["beta"]));

			const before = container.render(80);
			container.clear();
			const after = container.render(80);

			expect(before).toEqual(["alpha", "beta"]);
			expect(after).toEqual([]);
			expect(after).not.toBe(before);
		});

		it("invalidate marks dirty", () => {
			const container = new Container();
			const child = new CountingComponent(["alpha"]);
			container.addChild(child);

			const before = container.render(80);
			container.invalidate();
			const after = container.render(80);

			expect(after).toEqual(["alpha"]);
			expect(after).not.toBe(before);
			expect(child.renderCount).toBe(2);
		});

		it("width change forces re-render even when clean", () => {
			const container = new Container();
			const child = new CountingComponent(["alpha"]);
			container.addChild(child);

			const first = container.render(80);
			const second = container.render(100);

			expect(second).toEqual(["alpha"]);
			expect(second).not.toBe(first);
			expect(child.renderCount).toBe(2);
		});
	});

	describe("cache identity", () => {
		it("returns same array reference when clean and same width", () => {
			const container = new Container();
			container.addChild(new CountingComponent(["alpha"]));

			const first = container.render(80);
			const second = container.render(80);

			expect(second).toBe(first);
		});

		it("returns different array after markDirty", () => {
			const container = new Container();
			container.addChild(new CountingComponent(["alpha"]));

			const first = container.render(80);
			container.markDirty();
			const second = container.render(80);

			expect(second).toEqual(["alpha"]);
			expect(second).not.toBe(first);
		});
	});

	describe("upward propagation", () => {
		it("markDirty propagates to parent", () => {
			const parent = new Container();
			const child = new Container();
			const leaf = new CountingComponent(["alpha"]);
			child.addChild(leaf);
			parent.addChild(child);

			const first = parent.render(80);
			child.markDirty();
			const second = parent.render(80);

			expect(second).toEqual(["alpha"]);
			expect(second).not.toBe(first);
			expect(leaf.renderCount).toBe(2);
		});

		it("markDirty is idempotent", () => {
			const parent = new Container();
			const child = new Container();
			const leaf = new CountingComponent(["alpha"]);
			child.addChild(leaf);
			parent.addChild(child);

			parent.render(80);
			child.markDirty();
			child.markDirty();
			const lines = parent.render(80);

			expect(lines).toEqual(["alpha"]);
			expect(leaf.renderCount).toBe(2);
		});

		it("nested propagation: grandchild to parent", () => {
			const root = new Container();
			const middle = new Container();
			const inner = new Container();
			const leaf = new CountingComponent(["alpha"]);
			inner.addChild(leaf);
			middle.addChild(inner);
			root.addChild(middle);

			const first = root.render(80);
			inner.markDirty();
			const second = root.render(80);

			expect(second).toEqual(["alpha"]);
			expect(second).not.toBe(first);
			expect(leaf.renderCount).toBe(2);
		});
	});

	describe("selective re-rendering", () => {
		it("only dirty child re-renders", () => {
			const parent = new Container();
			const left = new Container();
			const right = new Container();
			const leftLeaf = new CountingComponent(["left"]);
			const rightLeaf = new CountingComponent(["right"]);
			left.addChild(leftLeaf);
			right.addChild(rightLeaf);
			parent.addChild(left);
			parent.addChild(right);

			parent.render(80);
			expect(leftLeaf.renderCount).toBe(1);
			expect(rightLeaf.renderCount).toBe(1);

			left.markDirty();
			const lines = parent.render(80);

			expect(lines).toEqual(["left", "right"]);
			expect(leftLeaf.renderCount).toBe(2);
			expect(rightLeaf.renderCount).toBe(1);
		});
	});

	describe("parent tracking", () => {
		it("addChild sets parent on child Container", () => {
			const parent = new Container();
			const child = new Container();
			const leaf = new CountingComponent(["alpha"]);
			child.addChild(leaf);
			parent.addChild(child);

			parent.render(80);
			child.markDirty();
			parent.render(80);

			expect(leaf.renderCount).toBe(2);
		});

		it("removeChild clears parent", () => {
			const parent = new Container();
			const child = new Container();
			const leaf = new CountingComponent(["alpha"]);
			child.addChild(leaf);
			parent.addChild(child);

			parent.render(80);
			parent.removeChild(child);
			child.markDirty();
			const lines = parent.render(80);

			expect(lines).toEqual([]);
			expect(leaf.renderCount).toBe(1);
		});

		it("clear clears all parent refs", () => {
			const parent = new Container();
			const firstChild = new Container();
			const secondChild = new Container();
			const firstLeaf = new CountingComponent(["first"]);
			const secondLeaf = new CountingComponent(["second"]);
			firstChild.addChild(firstLeaf);
			secondChild.addChild(secondLeaf);
			parent.addChild(firstChild);
			parent.addChild(secondChild);

			parent.render(80);
			parent.clear();
			firstChild.markDirty();
			secondChild.markDirty();
			const lines = parent.render(80);

			expect(lines).toEqual([]);
			expect(firstLeaf.renderCount).toBe(1);
			expect(secondLeaf.renderCount).toBe(1);
		});

		it("re-adding to different parent updates ref", () => {
			const parentA = new Container();
			const parentB = new Container();
			const child = new Container();
			const leaf = new CountingComponent(["alpha"]);
			child.addChild(leaf);
			parentA.addChild(child);
			parentA.render(80);

			parentA.removeChild(child);
			parentB.addChild(child);
			parentB.render(80);

			child.markDirty();
			const linesA = parentA.render(80);
			const linesB = parentB.render(80);

			expect(linesA).toEqual([]);
			expect(linesB).toEqual(["alpha"]);
			expect(leaf.renderCount).toBe(2);
		});
	});
});
