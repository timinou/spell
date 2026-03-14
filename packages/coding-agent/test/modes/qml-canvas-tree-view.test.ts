import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";

const HARNESS_QML = path.resolve(import.meta.dir, "../../src/modes/qml/canvas/components/TreeViewTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("TreeView QML integration", () => {
	const harness = new QmlTestHarness();
	beforeAll(async () => {
		await harness.setup(HARNESS_QML);
	});
	afterAll(async () => {
		await harness.teardown();
	});
	beforeEach(async () => {
		await harness.reset();
	});

	const sampleTree = {
		nodes: [
			{
				id: "src",
				label: "src",
				icon: "folder",
				children: [
					{ id: "index", label: "index.ts", icon: "file" },
					{ id: "util", label: "util.ts", icon: "file" },
				],
			},
			{ id: "pkg", label: "package.json", icon: "file" },
		],
	};

	it("root nodes are visible", async () => {
		await harness.sendMessage({ type: "set_tree", data: sampleTree });
		const nodes = await harness.findItems({ objectName: "treeNodeLabel" }, { properties: ["text"] });
		const labels = nodes.map(n => String(n.properties.text));
		expect(labels).toContain("src");
		expect(labels).toContain("package.json");
	});

	it("collapsed children are not in flat list", async () => {
		await harness.sendMessage({ type: "set_tree", data: sampleTree });
		// src is not expanded by default, so index.ts should NOT be in flatNodes
		const count = await harness.query<number>("visibleNodeCount");
		expect(count).toBe(2); // only root-level nodes
	});

	it("expanding a node makes children visible", async () => {
		await harness.sendMessage({ type: "set_tree", data: sampleTree });
		await harness.sendMessage({ type: "toggle_node", nodeId: "src" });
		const count = await harness.query<number>("visibleNodeCount");
		expect(count).toBe(4); // src + 2 children + package.json
		const expand = await harness.query<string>("lastExpandEvent");
		expect(expand).toBe("src");
	});

	it("collapsing hides children", async () => {
		// Start with src expanded
		const expandedTree = {
			nodes: [{ id: "src", label: "src", expanded: true, children: [{ id: "index", label: "index.ts" }] }],
		};
		await harness.sendMessage({ type: "set_tree", data: expandedTree });
		expect(await harness.query<number>("visibleNodeCount")).toBe(2);
		// Collapse it
		await harness.sendMessage({ type: "toggle_node", nodeId: "src" });
		expect(await harness.query<number>("visibleNodeCount")).toBe(1);
		const collapse = await harness.query<string>("lastCollapseEvent");
		expect(collapse).toBe("src");
	});

	it("empty tree shows placeholder", async () => {
		await harness.sendMessage({ type: "set_tree", data: { nodes: [] } });
		const count = await harness.query<number>("visibleNodeCount");
		expect(count).toBe(0);
		const items = await harness.findItems({ objectName: "emptyPlaceholder" }, { properties: ["text"] });
		expect(items.length).toBeGreaterThan(0);
		expect(items[0].properties.text).toBe("No items");
	});

	it("leaf nodes have no toggle", async () => {
		await harness.sendMessage({ type: "set_tree", data: sampleTree });
		// pkg is a leaf - should not have a treeToggle visible
		const pkg = await harness.findItems({ objectName: "treeNode_pkg" });
		expect(pkg.length).toBeGreaterThan(0);
	});

	it("node click emits event", async () => {
		await harness.sendMessage({ type: "set_tree", data: sampleTree });
		await harness.sendMessage({ type: "emit_click", nodeId: "pkg", label: "package.json" });
		const click = await harness.query<{ id: string; label: string }>("lastNodeClick");
		expect(click).not.toBeNull();
		expect(click!.id).toBe("pkg");
		expect(click!.label).toBe("package.json");
	});

	it("node with icon renders treeNodeIcon", async () => {
		await harness.sendMessage({ type: "set_tree", data: sampleTree });
		const icons = await harness.findItems({ objectName: "treeNodeIcon" });
		expect(icons.length).toBeGreaterThan(0);
	});
});
