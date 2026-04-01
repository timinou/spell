import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { isBridgeAvailable, QmlTestHarness } from '@oh-my-pi/pi-qml';
import * as path from 'node:path';

const HARNESS = path.resolve(import.meta.dir, '../../src/qml/panels/GrowthDashboardTestHarness.qml');

describe.skipIf(!isBridgeAvailable())('GrowthDashboard Panel', () => {
    const harness = new QmlTestHarness();

    beforeAll(async () => { await harness.setup(HARNESS); });
    afterAll(async () => { await harness.teardown(); });
    beforeEach(async () => { await harness.reset(); });

    test('renders metric cards with seeded data', async () => {
        await harness.sendMessage({
            type: 'dashboard_data',
            metrics: { newAds: 42, pendingDeliverables: 7, activeCampaigns: 3 },
            recentAds: [],
            pipeline: { brief: 2, draft: 3, review: 1, final: 1, sent: 0 },
        });
        await Bun.sleep(200);

        const texts = await harness.findVisibleText();
        expect(texts).toContain('42');
        expect(texts).toContain('7');
        expect(texts).toContain('3');
    });

    test('renders ad cards in competitor feed', async () => {
        await harness.sendMessage({
            type: 'dashboard_data',
            metrics: { newAds: 1, pendingDeliverables: 0, activeCampaigns: 0 },
            recentAds: [
                { adId: 'ad_001', pageName: 'Acme Corp', creativeBody: 'Shop our sale!', deliveryStartTime: '2026-03-15', isActive: true, adFormat: 'image' },
            ],
            pipeline: { brief: 0, draft: 0, review: 0, final: 0, sent: 0 },
        });
        await Bun.sleep(200);

        const texts = await harness.findVisibleText();
        expect(texts).toContain('Acme Corp');
        expect(texts.some(t => t.includes('Shop our sale'))).toBe(true);
    });

    test('quick action buttons are visible', async () => {
        await Bun.sleep(200);
        // Qt Controls 2 Button's text resides on the Button item itself (not QQuickText/QQuickLabel).
        // Use textContains to find each button regardless of its internal implementation.
        const newReport = await harness.findItems({ textContains: 'New Report', visible: true });
        const scanComp = await harness.findItems({ textContains: 'Scan Competitors', visible: true });
        const reviewPerf = await harness.findItems({ textContains: 'Review Performance', visible: true });
        expect(newReport.length).toBeGreaterThan(0);
        expect(scanComp.length).toBeGreaterThan(0);
        expect(reviewPerf.length).toBeGreaterThan(0);
    });

    test('metric cards have positive height', async () => {
        await harness.sendMessage({
            type: 'dashboard_data',
            metrics: { newAds: 10, pendingDeliverables: 5, activeCampaigns: 2 },
            recentAds: [],
            pipeline: { brief: 0, draft: 0, review: 0, final: 0, sent: 0 },
        });
        await Bun.sleep(200);

        const items = await harness.findItems(
            { type: 'QQuickText', textContains: '10', visible: true },
            { includeGeometry: true },
        );
        expect(items.length).toBeGreaterThan(0);
        expect(items[0].geometry!.height).toBeGreaterThan(0);
    });
});
