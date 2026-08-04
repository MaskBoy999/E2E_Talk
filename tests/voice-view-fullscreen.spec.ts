import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
    const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(friendCode2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: friendCode2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function setupServerWithChannels(page: any, suffix: string) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'VView_' + suffix);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id'));
    const token = await page.evaluate(() => localStorage.getItem('token'));
    async function createChannel(name: string, type: string) {
        const enc = await page.evaluate(async (n) => {
            const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')));
            return E2ECrypto.aeadEncrypt(n, new Uint8Array(k));
        }, name);
        const res = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { encrypted_name: enc.ciphertext, name_nonce: enc.nonce, channel_type: type },
        });
        expect(res.ok()).toBeTruthy();
        return (await res.json()).id;
    }
    const textId = await createChannel('general', 'text');
    const voiceId = await createChannel('lounge', 'voice');
    await page.click(`.server-icon[data-id="${serverId}"]`);
    await page.waitForSelector(`.channel-item[data-id="${textId}"]`, { timeout: 10000 });
    return { serverId, textId, voiceId };
}

function popupGeometry(page: any) {
    return page.evaluate(() => {
        const p = document.getElementById('voice-popup');
        if (!p) return null;
        const r = p.getBoundingClientRect();
        return { display: getComputedStyle(p).display, left: r.left, top: r.top, width: r.width, vw: window.innerWidth };
    });
}

test.describe('voice view: auto-close + fullscreen', () => {
    test('clicking a text channel closes the voice view (incl. re-clicking the selected channel)', async ({ page }) => {
        const ts = Date.now();
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));
        await registerUser(page, 'vclose_' + ts);
        const { textId, voiceId } = await setupServerWithChannels(page, ts);

        // Select the text channel explicitly (so it is the CURRENT channel)
        await page.click(`.channel-item[data-id="${textId}"]`);
        await page.waitForSelector('.message-list .welcome', { timeout: 10000 });

        // Join the voice channel, then open the voice view
        await page.click(`.channel-item[data-id="${voiceId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });
        await page.click(`.channel-item[data-id="${voiceId}"]`);
        await page.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });

        // Re-clicking the ALREADY-selected text channel must close the view too
        await page.click(`.channel-item[data-id="${textId}"]`);
        await page.waitForTimeout(500);
        const g1 = await popupGeometry(page);
        expect(g1!.display).toBe('none');

        // Reopen, then click the voice channel again (toggle) — view closes
        await page.click(`.channel-item[data-id="${voiceId}"]`);
        await page.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });
        await page.click(`.channel-item[data-id="${voiceId}"]`);
        await page.waitForTimeout(500);
        const g2 = await popupGeometry(page);
        expect(g2!.display).toBe('none');
        expect(errors).toEqual([]);
    });

    test('voice view fullscreen covers the whole screen and exits back to the column', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'vfull_' + ts);
        const { voiceId } = await setupServerWithChannels(page, ts);

        await page.click(`.channel-item[data-id="${voiceId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });
        await page.click(`.channel-item[data-id="${voiceId}"]`);
        await page.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });

        // Enter fullscreen → covers the whole viewport (left: 0, full width)
        await page.click('#voice-popup-fullscreen');
        await page.waitForTimeout(300);
        const fs = await popupGeometry(page);
        expect(fs!.left).toBe(0);
        expect(fs!.top).toBe(0);
        expect(fs!.width).toBeGreaterThanOrEqual(fs!.vw - 2);

        // Exit fullscreen → back to the chat column (left > 0)
        await page.click('#voice-popup-fullscreen');
        await page.waitForTimeout(300);
        const back = await popupGeometry(page);
        expect(back!.left).toBeGreaterThan(0);
    });

    test('expanded DM call covers the whole screen and collapses back to the top panel', async ({ page, context }) => {
        const ts = Date.now();
        await registerUser(page, 'dmfull1_' + ts);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const u2 = await registerUser(page2, 'dmfull2_' + ts);
        const u1 = await page.evaluate(() => ({ token: localStorage.getItem('token') }));
        await becomeFriends(page, page2, u1.token, u2.token);

        await page.click('#dm-strip-btn');
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        await page.waitForSelector('.dm-call-btn', { timeout: 10000 });

        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item', { timeout: 15000 });
        await page2.click('.dm-item');
        await page2.waitForSelector('.dm-call-btn', { timeout: 10000 });

        // P1 starts the call, P2 joins
        await page.click('.dm-call-btn');
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });
        await page2.click('.dm-call-btn');
        await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        const geom = (p: any) => p.evaluate(() => {
            const el = document.getElementById('dm-call-panel');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, vw: window.innerWidth, expanded: el.classList.contains('expanded') };
        });

        // Collapsed = top panel of the chat column (left > 0)
        const collapsed = await geom(page);
        expect(collapsed!.expanded).toBe(false);
        expect(collapsed!.left).toBeGreaterThan(0);

        // Expand → covers the whole screen (left 0, top 0, full width)
        await page.click('#dm-call-expand');
        await page.waitForTimeout(300);
        const expanded = await geom(page);
        expect(expanded!.expanded).toBe(true);
        expect(expanded!.left).toBe(0);
        expect(expanded!.top).toBe(0);
        expect(expanded!.width).toBeGreaterThanOrEqual(expanded!.vw - 2);

        // Collapse → back to the top panel
        await page.click('#dm-call-expand');
        await page.waitForTimeout(300);
        const back = await geom(page);
        expect(back!.expanded).toBe(false);
        expect(back!.left).toBeGreaterThan(0);

        // Clean up: end the call on both sides
        await page.click('#dm-call-end');
        await page2.click('#dm-call-end');
    });
});
