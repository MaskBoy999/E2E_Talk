import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 15000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: any) {
    return await page.evaluate(() => new Promise((resolve) => {
        let tries = 0;
        const check = () => {
            tries++;
            if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
            else if (tries >= 60) resolve(false);
            else setTimeout(check, 200);
        };
        setTimeout(check, 500);
    }));
}

async function setupFriends(pageA: any, pageB: any, bodyA: any, bodyB: any) {
    const fcB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await pageA.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fcB },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await pageB.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${bodyB.token}` },
    })).json();
    const acc = await pageB.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function createDm(pageA: any, bodyA: any, bodyB: any) {
    const userData = await (await pageA.request.get(`${BASE}/api/user/${bodyB.user.username}`, {
        headers: { Authorization: `Bearer ${bodyA.token}` },
    })).json();
    const dm = await (await pageA.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${bodyA.token}` },
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
    await page.waitForFunction(() => typeof viewMode !== 'undefined' && viewMode === 'dms', undefined, { timeout: 10000 });
}

// Measure the DM panel header from the LIVE DOM: no hamburger, buttons at
// the right edge with the header's own padding.
async function measureHeader(page: any) {
    return await page.evaluate(() => {
        const panel = document.getElementById('dm-call-panel');
        const header = panel?.querySelector('.dm-call-header');
        const right = panel?.querySelector('.dm-call-header-right');
        const hamburger = panel?.querySelector('#dm-call-goto');
        if (!panel || !header || !right) return null;
        const pr = panel.getBoundingClientRect();
        const rr = right.getBoundingClientRect();
        const cs = getComputedStyle(header);
        return {
            hasHamburger: !!hamburger,
            btnRightFromPanelRight: Math.round(pr.right - rr.right),
            headerPaddingRight: parseFloat(cs.paddingRight),
            panelWidth: Math.round(pr.width),
        };
    });
}

test.describe('DM call panel header (in-conversation)', () => {

    for (const width of [827, 1100, 1440]) {
        test(`no hamburger; expand+close at right edge at ${width}px`, async ({ page }) => {
            test.setTimeout(120000);
            await page.setViewportSize({ width, height: 900 });
            const ts = Date.now();
            const userA = 'ha_' + ts;
            const userB = 'hb_' + ts;
            const bodyA = await registerUser(page, userA);
            await waitForWs(page);

            const ctxB = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true });
            const pageB = await ctxB.newPage();
            const bodyB = await registerUser(pageB, userB);
            await setupFriends(page, pageB, bodyA, bodyB);
            const { dm } = await createDm(page, bodyA, bodyB);
            await openDm(page);
            await waitForWs(page);

            await page.evaluate(({ dmId, uid, uname }) => {
                (window as any).VoiceManager.startDmCall(dmId, uid, uname);
            }, { dmId: dm.id, uid: bodyB.user.id, uname: userB });
            await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
            await page.waitForTimeout(600);

            const m1 = await measureHeader(page);
            expect(m1).not.toBeNull();
            // Hamburger must be GONE (we're already in the DM conversation)
            expect(m1!.hasHamburger).toBe(false);
            // Buttons sit at the right edge — only the header's padding between them
            console.log(`[${width}px] right=${m1!.btnRightFromPanelRight} pad=${m1!.headerPaddingRight} w=${m1!.panelWidth}`);
            expect(m1!.btnRightFromPanelRight).toBeLessThanOrEqual(m1!.headerPaddingRight + 2);
            expect(m1!.btnRightFromPanelRight).toBeGreaterThan(0);

            // Expand → still no hamburger, buttons still at the right edge
            await page.click('#dm-call-expand');
            await page.waitForTimeout(400);
            const m2 = await measureHeader(page);
            expect(m2!.hasHamburger).toBe(false);
            expect(m2!.btnRightFromPanelRight).toBeLessThanOrEqual(m2!.headerPaddingRight + 2);

            // Collapse back
            await page.click('#dm-call-expand');
            await page.waitForTimeout(400);
            const m3 = await measureHeader(page);
            expect(m3!.hasHamburger).toBe(false);
            expect(m3!.btnRightFromPanelRight).toBeLessThanOrEqual(m3!.headerPaddingRight + 2);

            await ctxB.close();
        });
    }

    test('DM mini bar keeps its hamburger (needed to reach the conversation)', async ({ page }) => {
        test.setTimeout(120000);
        await page.setViewportSize({ width: 827, height: 900 });
        await registerUser(page, 'hm_' + Date.now());
        await waitForWs(page);

        await page.evaluate(() => {
            const mb = document.getElementById('dm-mini-bar');
            mb.style.display = 'flex';
            document.getElementById('dm-mini-bar-name').textContent = 'In call with test1';
        });
        await page.waitForTimeout(400);

        const m = await page.evaluate(() => {
            const bar = document.getElementById('dm-mini-bar')!.getBoundingClientRect();
            const btn = document.getElementById('dm-mini-bar-goto')!.getBoundingClientRect();
            const cs = getComputedStyle(document.getElementById('dm-mini-bar-goto')!);
            return { btnRightFromBarRight: Math.round(bar.right - btn.right), barWidth: Math.round(bar.width), borderW: cs.borderTopWidth };
        });
        console.log('[mini bar]', JSON.stringify(m));
        // The mini bar's ☰ must still exist and hug the right edge
        expect(m.btnRightFromBarRight).toBeLessThan(m.barWidth / 2);
        expect(m.borderW).toBe('1px');
    });
});
