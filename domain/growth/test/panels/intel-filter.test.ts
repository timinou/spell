import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { isBridgeAvailable, QmlTestHarness } from '@oh-my-pi/pi-qml';
import * as path from 'node:path';

const HARNESS = path.resolve(import.meta.dir, '../../src/qml/panels/IntelPanelTestHarness.qml');

describe.skipIf(!isBridgeAvailable())('Intel Panel Filters', () => {
    const harness = new QmlTestHarness();

    beforeAll(async () => { await harness.setup(HARNESS); });
    afterAll(async () => { await harness.teardown(); });
    beforeEach(async () => { await harness.reset(); });

    test('filter controls render visible text', async () => {
        await Bun.sleep(200);

        // Verify filter toolbar renders searchable/filterable UI text
        const texts = await harness.findVisibleText();
        expect(texts.some(t => t.includes('Search') || t.includes('search') || t.includes('Active'))).toBe(true);
    });
});
