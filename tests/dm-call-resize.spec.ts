import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('DM call panel height resize', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
    }

    async function waitForWs(page: any) {
        return await page.evaluate(() => {
            return new Promise((resolve) => {
                let tries = 0;
                const check = () => {
                    tries++;
                    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                    else if (tries >= 60) resolve(false);
                    else setTimeout(check, 200);
                };
                setTimeout(check, 500);
            });
        });
    }

    async function setupFriends(page: any, page2: any, body1: any, body2: any) {
        const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: fc2 },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();
    }

    async function createDm(page: any, page2: any, body1: any, body2: any) {
        const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(dm.id).toBeTruthy();
        return { userData, dm };
    }

    async function openDm(page: any) {
        await page.click('#dm-strip-btn').catch(() => {});
        await page.waitForTimeout(800);
        for (let i = 0; i < 40; i++) {
            const conv = page.locator('.dm-item, .dm-conv, [data-dm-id]');
            if (await conv.count()) {
                await conv.first().click().catch(() => {});
                await page.waitForTimeout(800);
                break;
            }
            await page.waitForTimeout(300);
        }
    }

    test('drag the bottom handle to resize the DM call panel height, persists + survives sync', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'dmr1_' + ts;
        const user2 = 'dmr2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);

        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);

        // Start the call
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });

        // Panel becomes visible
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
        const before = await page.evaluate(() => document.getElementById('dm-call-panel')!.offsetHeight);
        expect(before).toBeGreaterThan(100);

        // Drag the resize handle down by ~180px
        const handle = page.locator('#dm-call-resize');
        await handle.waitFor({ state: 'visible', timeout: 10000 });
        const box = await handle.boundingBox();
        expect(box).toBeTruthy();
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 180, { steps: 8 });
        await page.mouse.up();

        const after = await page.evaluate(() => document.getElementById('dm-call-panel')!.offsetHeight);
        expect(after).toBeGreaterThan(before + 100);

        // Persisted to localStorage
        const saved = await page.evaluate(() => parseInt(localStorage.getItem('dm_call_panel_h') || '0', 10));
        expect(saved).toBeGreaterThan(before + 100);

        // syncOverlayBounds (window resize) re-applies the saved height, not the CSS default
        await page.evaluate(() => window.dispatchEvent(new Event('resize')));
        await page.waitForTimeout(200);
        const afterSync = await page.evaluate(() => document.getElementById('dm-call-panel')!.offsetHeight);
        expect(Math.abs(afterSync - after)).toBeLessThanOrEqual(2);

        // Expand to full screen hides the handle and overrides height; collapsing restores it
        await page.evaluate(() => {
            const v = window.VoiceManager as any;
            const s = v._debug.state;
            if (!s.dmCallExpanded) v.toggleDmExpand && v.toggleDmExpand();
        });
        await page.waitForTimeout(200);
        expect(await page.locator('#dm-call-resize').isVisible().catch(() => false)).toBeFalsy();

        // Collapse again → handle back, custom height restored
        await page.evaluate(() => {
            const v = window.VoiceManager as any;
            if (v._debug.state.dmCallExpanded) v.toggleDmExpand && v.toggleDmExpand();
        });
        await page.waitForTimeout(300);
        expect(await page.locator('#dm-call-resize').isVisible().catch(() => false)).toBeTruthy();
        const afterCollapse = await page.evaluate(() => document.getElementById('dm-call-panel')!.offsetHeight);
        expect(Math.abs(afterCollapse - after)).toBeLessThanOrEqual(2);

        await ctx2.close();
    });
});
