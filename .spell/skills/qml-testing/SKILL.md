---
name: qml-testing
description: Headless QML integration testing using the bridge's DOM introspection, JS evaluation, and screenshot APIs. Use when writing or debugging QML UI tests.
---

# QML Testing

## Setup

```typescript
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";
import * as path from "node:path";

const HARNESS_QML = path.resolve(import.meta.dir, "../../src/modes/qml/panels/ChatPanelTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("MyComponent QML", () => {
    const harness = new QmlTestHarness();

    beforeAll(async () => { await harness.setup(HARNESS_QML); });
    afterAll(async () => { await harness.teardown(); });
    beforeEach(async () => { await harness.reset(); });

    it("test", async () => {
        await harness.sendMessage({ type: "user_message", text: "hello" });
        await Bun.sleep(200); // settle QML rendering
        const texts = await harness.findVisibleText();
        expect(texts).toContain("hello");
    });
});
```

The harness QML must be co-located with the component under test so relative import paths (`"../SpellUI"`) resolve correctly.

## Bridge DOM Query API

### `findItems(selector?, options?)` → `QueryItem[]`

Walks the visual tree from the QML root and returns all matching items.

```typescript
const items = await harness.findItems(
    { type: "QQuickText", textContains: "hello", visible: true },
    { properties: ["text", "color"], includeGeometry: true, maxDepth: 15 },
);
```

**Selector fields** (all optional — empty selector matches everything):
- `type`: className prefix match. `"QQuickText"` matches `QQuickText` and `QQuickText_QMLTYPE_42`.
- `objectName`: exact match on QML `id` (which sets the objectName). Set `id: myItem` in QML.
- `visible`: `true` / `false` — filters by `isVisible()`.
- `textContains`: substring match on the `text` property.

**Options**:
- `properties`: list of property names to read. Dotted paths work: `"font.pixelSize"`, `"anchors.topMargin"`.
- `includeGeometry`: include `geometry` (local x/y/width/height) and `scenePosition` (absolute x/y) fields.
- `maxDepth`: max tree depth (default 20). Reduce for performance when you know the depth.

**`QueryItem` shape**:
```typescript
{
    className: string;       // e.g. "QQuickText"
    objectName: string;      // QML id value, or ""
    visible: boolean;
    opacity: number;
    enabled: boolean;
    clip: boolean;
    childCount: number;
    path: string;            // e.g. "ApplicationWindow/Rectangle/Text"
    geometry?: { x: number; y: number; width: number; height: number };
    scenePosition?: { x: number; y: number };
    properties: Record<string, unknown>;
}
```

### `findVisibleText()` → `string[]`

Shorthand: all visible `QQuickText` elements, returning their `text` property values.

```typescript
const texts = await harness.findVisibleText();
expect(texts).toContain("Expected label");
```

### `assertVisible(selector)` → `QueryItem`

Asserts an element exists, is visible, and has positive dimensions. Throws with a descriptive message on failure.

```typescript
const item = await harness.assertVisible({ type: "QQuickText", textContains: "Submit" });
```

### `assertNotFound(selector)`

Asserts no element matches the selector.

```typescript
await harness.assertNotFound({ objectName: "errorBanner" });
```

### `evaluate<T>(expression)` → `T`

Evaluates a JS expression in the QML engine context. `root` refers to the root QML object.

```typescript
const count = await harness.evaluate<number>("root.messagesModel.count");
const isStreaming = await harness.evaluate<boolean>("root.chatPanel.isStreaming");
await harness.evaluate("root.chatPanel.messagesModel.clear()");
```

Throws if the expression produces a QJSValue error.

## Common Patterns

### Verify text content

```typescript
const texts = await harness.findVisibleText();
expect(texts).toContain("Expected text");
```

### Verify element geometry

```typescript
const items = await harness.findItems(
    { type: "QQuickRectangle", visible: true },
    { includeGeometry: true },
);
expect(items[0].geometry!.height).toBeGreaterThan(0);
```

### Verify vertical stacking

```typescript
const items = await harness.findItems(
    { type: "QQuickText", visible: true },
    { includeGeometry: true, properties: ["text"] },
);
const a = items.find(i => i.properties["text"] === "first");
const b = items.find(i => i.properties["text"] === "second");
expect(b!.scenePosition!.y).toBeGreaterThan(a!.scenePosition!.y);
```

### Read model state

Use `evaluate` for internal QML model state, not `findItems`. The visual tree doesn't expose model data directly.

```typescript
const count = await harness.evaluate<number>("root.messagesModel.count");
```

### QML-side query protocol (legacy)

The `harness.query(queryName)` method sends `{type:"query", query:queryName}` to the QML window and awaits a `query_response` event. This requires the test harness QML to implement the query handler. Use `evaluate` instead where possible — it requires no QML-side boilerplate.

## Settle Time

QML rendering is asynchronous. After sending messages, wait 200ms before issuing DOM queries:

```typescript
await harness.sendMessage({ ... });
await Bun.sleep(200);
const texts = await harness.findVisibleText();
```

For complex animations or heavy delegates, increase to 500ms.

## Test Wrapper QML Requirements

Test harness QML files must:
1. Use `ApplicationWindow` as root (required for QQuickWindow content item access)
2. Handle `reset` messages and confirm with `bridge.send({ type: "reset_done" })`
3. Be co-located with the component under test (module imports use relative paths)
4. Handle messages via `Connections { target: bridge; function onMessageReceived(p) { ... } }`

## Query vs Screenshot

- **DOM queries**: Correctness assertions (text content, visibility, layout, dimensions). Fast, deterministic, no image artifacts.
- **Screenshots**: Visual regression (colors, fonts, spacing). Only when appearance matters and can be compared.

Prefer DOM queries for all correctness tests. Screenshots are evidence, not assertions.

## Anti-Patterns

- **Model-only assertions**: Querying `messagesModel.count` tells you the model is correct, not that anything renders. Use `findVisibleText()` to verify rendering.
- **Hardcoded tree paths**: Don't assert on exact `path` strings from `QueryItem`. Paths include QML-generated suffixes that change. Use selector-based matching.
- **Missing settle time**: QML rendering is async. `sendMessage` returns immediately; the visual tree updates on the next Qt event loop cycle. Always `await Bun.sleep(200)` before visual queries.
- **`objectName` requirements on production QML**: The selector works without `objectName` via type + property matching. Don't add `id` properties to production QML just for tests.
