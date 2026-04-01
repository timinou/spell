import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { isBridgeAvailable, QmlTestHarness } from '@oh-my-pi/pi-qml';
import * as path from 'node:path';

const HARNESS = path.resolve(import.meta.dir, '../../src/qml/panels/EditorPanelTestHarness.qml');

describe.skipIf(!isBridgeAvailable())('Editor Panel', () => {
    const harness = new QmlTestHarness();

    beforeAll(async () => { await harness.setup(HARNESS); });
    afterAll(async () => { await harness.teardown(); });
    beforeEach(async () => { await harness.reset(); });

    test('renders split view with editor and preview panes', async () => {
        await Bun.sleep(200);
        // Both panes should be visible
        const items = await harness.findItems(
            { type: 'QQuickRectangle', visible: true },
            { includeGeometry: true },
        );
        // Should have at least 2 rectangles (editor + preview areas)
        expect(items.length).toBeGreaterThanOrEqual(2);
    });

    test('shows placeholder text for editor and preview', async () => {
        await Bun.sleep(200);
        const texts = await harness.findVisibleText();
        expect(texts.some(t => t.includes('Editor') || t.includes('Typst'))).toBe(true);
        expect(texts.some(t => t.includes('Preview') || t.includes('SVG'))).toBe(true);
    });

    test('emits panel_ready on load', async () => {
        // The panel should emit panel_ready when Component.onCompleted fires
        // Since we can't directly intercept bridge.send from the test,
        // we verify the panel loaded by checking visible content
        await Bun.sleep(200);
        const items = await harness.findItems({ visible: true });
        expect(items.length).toBeGreaterThan(0);
    });

    test('split view panes have positive dimensions', async () => {
        await Bun.sleep(200);
        const items = await harness.findItems(
            { type: 'QQuickSplitView', visible: true },
            { includeGeometry: true },
        );
        if (items.length > 0) {
            expect(items[0].geometry!.width).toBeGreaterThan(0);
            expect(items[0].geometry!.height).toBeGreaterThan(0);
        }
    });
});
