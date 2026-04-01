import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { isBridgeAvailable, QmlTestHarness } from '@oh-my-pi/pi-qml';
import * as path from 'node:path';

const HARNESS = path.resolve(import.meta.dir, '../../src/qml/panels/IntelPanelTestHarness.qml');

describe.skipIf(!isBridgeAvailable())('Intel Panel', () => {
    const harness = new QmlTestHarness();

    beforeAll(async () => { await harness.setup(HARNESS); });
    afterAll(async () => { await harness.teardown(); });
    beforeEach(async () => { await harness.reset(); });

    test('renders with ad data from armed tool response', async () => {
        await harness.sendMessage({
            type: 'ads_query_result',
            ads: [
                { adId: 'ad_001', pageId: 'p1', pageName: 'Acme Corp', creativeBody: 'Try our product!', deliveryStartTime: '2026-03-01', isActive: true, adFormat: 'image' },
                { adId: 'ad_002', pageId: 'p2', pageName: 'Beta Inc', creativeBody: 'Limited offer', deliveryStartTime: '2026-03-10', isActive: false, adFormat: 'video' },
            ],
            total: 2,
        });
        await Bun.sleep(200);

        const texts = await harness.findVisibleText();
        expect(texts).toContain('Acme Corp');
        expect(texts).toContain('Beta Inc');
    });

    test('shows empty state when no ads', async () => {
        await harness.sendMessage({ type: 'ads_query_result', ads: [], total: 0 });
        await Bun.sleep(200);

        const texts = await harness.findVisibleText();
        // IntelPanel renders "No ads match the current filter" when the grid is empty
        expect(texts.some(t => t.toLowerCase().includes('no') || t.toLowerCase().includes('scan'))).toBe(true);
    });

    test('filter toolbar is visible', async () => {
        await Bun.sleep(200);
        // FilterToolbar renders visible text like placeholder or label
        const texts = await harness.findVisibleText();
        // The toolbar should contain searchable text or filter labels
        expect(texts.some(t => t.includes('Search') || t.includes('search') || t.includes('Filter') || t.includes('Active'))).toBe(true);
    });
});
