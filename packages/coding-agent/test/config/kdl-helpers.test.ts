import { describe, expect, it } from "bun:test";
import { parse } from "@bgotink/kdl";

import {
	createBooleanNode,
	createNumberNode,
	createPropertyNode,
	createStringNode,
	ensureChildrenBlock,
	findOrCreateChildNode,
	findOrCreateDocumentNode,
	getBooleanArgument,
	getBooleanProperty,
	getChildNode,
	getChildNodes,
	getDocumentNode,
	getNumberArgument,
	getNumberProperty,
	getStringArgument,
	getStringArguments,
	getStringProperty,
	setArgument,
} from "../../src/config/kdl-helpers";

// ── Test fixtures ────────────────────────────────────────────────────────

function parseNode(kdl: string) {
	const doc = parse(kdl);
	return doc.nodes[0]!;
}

// ── Argument Accessors ───────────────────────────────────────────────────

describe("getStringArgument", () => {
	it("returns string at index 0", () => {
		expect(getStringArgument(parseNode('node "hello"'))).toBe("hello");
	});

	it("returns string at specified index", () => {
		expect(getStringArgument(parseNode('node "first" "second"'), 1)).toBe("second");
	});

	it("returns undefined for missing index", () => {
		expect(getStringArgument(parseNode('node "only"'), 5)).toBeUndefined();
	});

	it("returns undefined for non-string (boolean)", () => {
		expect(getStringArgument(parseNode("node #true"))).toBeUndefined();
	});

	it("returns undefined for non-string (number)", () => {
		expect(getStringArgument(parseNode("node 42"))).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(getStringArgument(parseNode('node ""'))).toBeUndefined();
	});

	it("returns undefined for null argument", () => {
		expect(getStringArgument(parseNode("node #null"))).toBeUndefined();
	});
});

describe("getBooleanArgument", () => {
	it("returns true", () => {
		expect(getBooleanArgument(parseNode("node #true"))).toBe(true);
	});

	it("returns false", () => {
		expect(getBooleanArgument(parseNode("node #false"))).toBe(false);
	});

	it("returns undefined for non-boolean", () => {
		expect(getBooleanArgument(parseNode('node "hello"'))).toBeUndefined();
	});

	it("returns undefined for missing", () => {
		expect(getBooleanArgument(parseNode("node"), 0)).toBeUndefined();
	});
});

describe("getNumberArgument", () => {
	it("returns integer", () => {
		expect(getNumberArgument(parseNode("node 42"))).toBe(42);
	});

	it("returns float", () => {
		expect(getNumberArgument(parseNode("node 3.14"))).toBe(3.14);
	});

	it("returns negative number", () => {
		expect(getNumberArgument(parseNode("node -1"))).toBe(-1);
	});

	it("returns undefined for non-number", () => {
		expect(getNumberArgument(parseNode('node "hello"'))).toBeUndefined();
	});

	it("returns undefined for missing", () => {
		expect(getNumberArgument(parseNode("node"))).toBeUndefined();
	});
});

describe("getStringArguments", () => {
	it("returns all string arguments", () => {
		expect(getStringArguments(parseNode('node "a" "b" "c"'))).toEqual(["a", "b", "c"]);
	});

	it("skips non-string arguments", () => {
		expect(getStringArguments(parseNode('node "a" 42 "b" #true "c"'))).toEqual(["a", "b", "c"]);
	});

	it("returns empty array when no arguments", () => {
		expect(getStringArguments(parseNode("node"))).toEqual([]);
	});

	it("skips empty strings", () => {
		expect(getStringArguments(parseNode('node "" "a" ""'))).toEqual(["a"]);
	});
});

// ── Property Accessors ───────────────────────────────────────────────────

describe("getStringProperty", () => {
	it("returns property value", () => {
		expect(getStringProperty(parseNode('node key="value"'), "key")).toBe("value");
	});

	it("returns undefined for missing property", () => {
		expect(getStringProperty(parseNode('node key="value"'), "other")).toBeUndefined();
	});

	it("returns undefined for non-string property", () => {
		expect(getStringProperty(parseNode("node key=42"), "key")).toBeUndefined();
	});

	it("returns undefined for empty string property", () => {
		expect(getStringProperty(parseNode('node key=""'), "key")).toBeUndefined();
	});
});

describe("getNumberProperty", () => {
	it("returns number property", () => {
		expect(getNumberProperty(parseNode("node count=42"), "count")).toBe(42);
	});

	it("returns undefined for non-number", () => {
		expect(getNumberProperty(parseNode('node count="hello"'), "count")).toBeUndefined();
	});

	it("returns undefined for missing", () => {
		expect(getNumberProperty(parseNode("node count=42"), "other")).toBeUndefined();
	});
});

describe("getBooleanProperty", () => {
	it("returns true property", () => {
		expect(getBooleanProperty(parseNode("node enabled=#true"), "enabled")).toBe(true);
	});

	it("returns false property", () => {
		expect(getBooleanProperty(parseNode("node enabled=#false"), "enabled")).toBe(false);
	});

	it("returns undefined for non-boolean", () => {
		expect(getBooleanProperty(parseNode('node enabled="yes"'), "enabled")).toBeUndefined();
	});

	it("returns undefined for missing", () => {
		expect(getBooleanProperty(parseNode("node enabled=#true"), "other")).toBeUndefined();
	});
});

// ── Child Node Navigation ────────────────────────────────────────────────

describe("getChildNode", () => {
	it("finds child by name", () => {
		const node = parseNode('parent { child "value" }');
		const child = getChildNode(node, "child");
		expect(child).toBeDefined();
		expect(getStringArgument(child!)).toBe("value");
	});

	it("returns undefined when not found", () => {
		const node = parseNode('parent { child "value" }');
		expect(getChildNode(node, "missing")).toBeUndefined();
	});

	it("returns undefined when no children block", () => {
		const node = parseNode("parent");
		expect(getChildNode(node, "child")).toBeUndefined();
	});
});

describe("getChildNodes", () => {
	it("returns all children", () => {
		const node = parseNode('parent { a "1"; b "2"; c "3" }');
		expect(getChildNodes(node)).toHaveLength(3);
	});

	it("filters by name", () => {
		const node = parseNode('parent { item "1"; other "x"; item "2" }');
		const items = getChildNodes(node, "item");
		expect(items).toHaveLength(2);
	});

	it("returns empty array when no children block", () => {
		const node = parseNode("parent");
		expect(getChildNodes(node)).toEqual([]);
	});

	it("returns empty array when no matches", () => {
		const node = parseNode('parent { a "1" }');
		expect(getChildNodes(node, "missing")).toEqual([]);
	});
});

describe("getDocumentNode", () => {
	it("finds top-level node by name", () => {
		const doc = parse('first "a"\nsecond "b"');
		const node = getDocumentNode(doc, "second");
		expect(node).toBeDefined();
		expect(getStringArgument(node!)).toBe("b");
	});

	it("returns last node when duplicates exist", () => {
		const doc = parse('node "first"\nnode "second"');
		const node = getDocumentNode(doc, "node");
		expect(getStringArgument(node!)).toBe("second");
	});

	it("returns undefined when not found", () => {
		const doc = parse('node "value"');
		expect(getDocumentNode(doc, "missing")).toBeUndefined();
	});
});

// ── Node Creation ────────────────────────────────────────────────────────

describe("createStringNode", () => {
	it("creates node with string argument", () => {
		const node = createStringNode("theme", "dark");
		expect(node.getName()).toBe("theme");
		expect(node.getArgument(0)).toBe("dark");
	});
});

describe("createBooleanNode", () => {
	it("creates node with true argument", () => {
		const node = createBooleanNode("enabled", true);
		expect(node.getName()).toBe("enabled");
		expect(node.getArgument(0)).toBe(true);
	});

	it("creates node with false argument", () => {
		const node = createBooleanNode("enabled", false);
		expect(node.getArgument(0)).toBe(false);
	});
});

describe("createNumberNode", () => {
	it("creates node with number argument", () => {
		const node = createNumberNode("count", 42);
		expect(node.getName()).toBe("count");
		expect(node.getArgument(0)).toBe(42);
	});
});

describe("createPropertyNode", () => {
	it("creates node with properties", () => {
		const node = createPropertyNode("theme", { dark: "titanium", light: "light" });
		expect(node.getName()).toBe("theme");
		expect(node.getProperty("dark")).toBe("titanium");
		expect(node.getProperty("light")).toBe("light");
	});

	it("handles mixed property types", () => {
		const node = createPropertyNode("config", { name: "test", count: 5, enabled: true });
		expect(node.getProperty("name")).toBe("test");
		expect(node.getProperty("count")).toBe(5);
		expect(node.getProperty("enabled")).toBe(true);
	});
});

// ── Mutation Helpers ─────────────────────────────────────────────────────

describe("ensureChildrenBlock", () => {
	it("creates children block on node without one", () => {
		const node = parseNode("parent");
		expect(node.children).toBeNull();
		const children = ensureChildrenBlock(node);
		expect(children).toBeDefined();
		expect(children.nodes).toEqual([]);
		// Same reference on second call
		expect(ensureChildrenBlock(node)).toBe(children);
	});

	it("returns existing children block", () => {
		const node = parseNode("parent { child }");
		const originalChildren = node.children!;
		expect(ensureChildrenBlock(node)).toBe(originalChildren);
	});
});

describe("findOrCreateChildNode", () => {
	it("returns existing child", () => {
		const node = parseNode('parent { child "existing" }');
		const child = findOrCreateChildNode(node, "child");
		expect(getStringArgument(child)).toBe("existing");
	});

	it("creates child when missing", () => {
		const node = parseNode("parent");
		const child = findOrCreateChildNode(node, "newChild");
		expect(child.getName()).toBe("newChild");
		expect(node.children).not.toBeNull();
		expect(node.children!.nodes).toHaveLength(1);
	});
});

describe("findOrCreateDocumentNode", () => {
	it("returns existing node", () => {
		const doc = parse('existing "value"');
		const node = findOrCreateDocumentNode(doc, "existing");
		expect(getStringArgument(node)).toBe("value");
	});

	it("creates node when missing", () => {
		const doc = parse('other "value"');
		const node = findOrCreateDocumentNode(doc, "newNode");
		expect(node.getName()).toBe("newNode");
		expect(doc.nodes).toHaveLength(2);
	});
});

describe("setArgument", () => {
	it("replaces existing argument", () => {
		const node = parseNode('node "old"');
		setArgument(node, "new");
		expect(node.getArgument(0)).toBe("new");
	});

	it("adds argument when none exists", () => {
		const node = parseNode("node");
		setArgument(node, "value");
		expect(node.getArgument(0)).toBe("value");
	});

	it("handles boolean values", () => {
		const node = parseNode("node #false");
		setArgument(node, true);
		expect(node.getArgument(0)).toBe(true);
	});

	it("handles number values", () => {
		const node = parseNode("node 0");
		setArgument(node, 42);
		expect(node.getArgument(0)).toBe(42);
	});
});
