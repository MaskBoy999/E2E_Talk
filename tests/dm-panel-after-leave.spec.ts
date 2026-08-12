import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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

async function createDm(page: any, body1: any, body2: any) {
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
    await page.locator('.dm-item').first().click().catch(() => {});
    await page.waitForTimeout(800);
}

test('Join from the waiting state after a previous leave still shows the DM call panel', async ({ page, context }) => {
    test.setTimeout(150000);
    const ts = Date.now();
    const userA = 'jwl1_' + ts;
    const userB = 'jwl2_' + ts;
    const ctxB = await context.browser()!.newContext();
    const pageB = await ctxB.newPage();
    const bodyB = await registerUser(pageB, userB);
    const bodyA = await registerUser(page, userA);
    await setupFriends(page, pageB, bodyA, bodyB);
    const { userData, dm } = await createDm(page, bodyA, bodyB);
    await waitForWs(page);
    await waitForWs(pageB);
    await page.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(3000));
    await pageB.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(3000));
    await openDm(pageB);

    // ---- Call 1: A calls B, B accepts, then B LEAVES. Leaving hides the DM
    // panel and — before the fix — permanently set dmPanelOpen=false.
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: userB });
    await pageB.waitForFunction(() => !!(window as any).VoiceManager.getIncomingCall(), undefined, { timeout: 15000 });
    await pageB.evaluate(() => (window as any).VoiceManager.acceptDmCall());
    await pageB.waitForFunction(() => !!(window as any).VoiceManager.isConnected && (window as any).VoiceManager.isConnected(), undefined, { timeout: 20000 });
    await pageB.waitForTimeout(800);
    expect(await pageB.evaluate(() => document.getElementById('dm-call-panel') ? getComputedStyle(document.getElementById('dm-call-panel')!).display : 'NO-EL')).toBe('flex');
    await pageB.evaluate(() => (window as any).VoiceManager.endDmCall());
    await pageB.waitForTimeout(1200);
    // Leaving set dmPanelOpen=false — the panel is hidden.
    expect(await pageB.evaluate(() => (window as any).VoiceManager._debug.state.dmPanelOpen)).toBe(false);

    // ---- Call 2: A calls B again. B's ring times out → the waiting banner
    // shows; B presses "Join Call" while ALREADY in the DM view (the path that
    // never went through selectDmChannel's resetDmPanelOpen).
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: userB });
    await pageB.waitForFunction(() => {
        const inc = (window as any).VoiceManager.getIncomingCall && (window as any).VoiceManager.getIncomingCall();
        return inc && inc.waiting;
    }, undefined, { timeout: 20000 });
    // Sanity: the banner is the visible Join affordance.
    const bannerDisplay = await pageB.evaluate(() => document.getElementById('dm-waiting-banner') ? getComputedStyle(document.getElementById('dm-waiting-banner')!).display : 'NO-EL');
    expect(bannerDisplay).toBe('flex');
    await pageB.evaluate(() => {
        const btn = document.getElementById('dm-waiting-join-btn');
        if (btn) (btn as HTMLButtonElement).click();
    });

    // The panel MUST appear — the fix resets dmPanelOpen on every call entry.
    await pageB.waitForFunction(() => {
        const p = document.getElementById('dm-call-panel');
        return p && getComputedStyle(p).display === 'flex';
    }, undefined, { timeout: 15000 });
    const after = await pageB.evaluate(() => ({
        dmPanelOpen: (window as any).VoiceManager._debug.state.dmPanelOpen,
        panelDisplay: document.getElementById('dm-call-panel') ? getComputedStyle(document.getElementById('dm-call-panel')!).display : 'NO-EL',
        connected: !!(window as any).VoiceManager.isConnected && (window as any).VoiceManager.isConnected(),
    }));
    console.log('[JWL] after call-2 Join:', JSON.stringify(after));
    expect(after.dmPanelOpen).toBe(true);
    expect(after.panelDisplay).toBe('flex');
    expect(after.connected).toBe(true);
});
