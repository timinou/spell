import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { isBridgeAvailable, QmlTestHarness } from '@oh-my-pi/pi-qml';
import * as path from 'node:path';

const HARNESS = path.resolve(import.meta.dir, '../../src/qml/panels/GrowthDashboardTestHarness.qml');

describe.skipIf(!isBridgeAvailable())('GrowthDashboard Empty State', () => {
    const harness = new QmlTestHarness();

    beforeAll(async () => { await harness.setup(HARNESS); });
    afterAll(async () => { await harness.teardown(); });
    beforeEach(async () => { await harness.reset(); });

    test('shows zero metrics on initial load', async () => {
        await Bun.sleep(200);
        const texts = await harness.findVisibleText();
        // All three metric cards default to 0 — at least three '0' values must appear
        expect(texts.filter(t => t === '0').length).toBeGreaterThanOrEqual(3);
    });

    test('shows quick action buttons even with no data', async () => {
        await Bun.sleep(200);
        // Qt Controls 2 Button's text property lives on the Button item itself.
        const items = await harness.findItems({ textContains: 'Scan Competitors', visible: true });
        expect(items.length).toBeGreaterThan(0);
    });
});
