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

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= maxRetries) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
    const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
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

test.describe('DM call panel layout (visual)', () => {

    test('DM call panel + voice bar screenshots', async ({ context }) => {
        test.setTimeout(120000);
        const ts = Date.now();

        const ctx1 = await context.browser()!.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx1.newPage();
        const ctx2 = await context.browser()!.newContext({ viewport: { width: 1280, height: 800 } });
        const page2 = await ctx2.newPage();

        const u1 = await registerUser(page, 'visdm1_' + ts);
        const u2 = await registerUser(page2, 'visdm2_' + ts);
        await becomeFriends(page, page2, u1.token, u2.token);
        await waitForWs(page);
        await waitForWs(page2);

        // Create a server with a voice channel on page1
        await page.click('#add-server-btn');
        await page.click('#choice-create-server');
        await page.fill('#new-server-name', 'VisTest_' + ts);
        await page.click('#confirm-create-server');
        await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
        const serverId = await page.evaluate(() =>
            document.querySelector('.server-icon[data-id]')?.getAttribute('data-id')
        );
        expect(serverId).toBeTruthy();

        const serverKey = await page.evaluate((sid) => localStorage.getItem('e2e_server_' + sid), serverId);
        const encName = await page.evaluate(async (k) => {
            const key = E2ECrypto.base64ToArrayBuffer(k);
            return E2ECrypto.aeadEncrypt('General', new Uint8Array(key));
        }, serverKey);
        const createCh = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
            data: { encrypted_name: encName.ciphertext, name_nonce: encName.nonce, channel_type: 'voice' },
        });
        expect(createCh.ok()).toBeTruthy();
        const channelId = (await createCh.json()).id;

        // Invite page2 to server
        const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
        await page.request.post(`${BASE}/api/servers/${serverId}/invite`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: code },
        });
        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' },
            data: { code },
        });

        // Open DM and start call on page1
        await page.click('#dm-strip-btn');
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        await page.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 10000 });
        await page.click('.dm-call-btns .dm-call-btn');
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // page2 accepts the call
        await page2.waitForFunction(() => window.VoiceManager?._debug?.state?.incomingCall !== null, undefined, { timeout: 20000 });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 15000 });
        await page2.click('#incoming-call-accept');
        await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        await page.waitForFunction(() => window.VoiceManager?.isConnected() && window.VoiceManager?.isInDmCall(), undefined, { timeout: 15000 });

        // Screenshot 1: DM call panel (both sides)
        await page.screenshot({ path: 'tests/screenshots/dm-call-panel-p1.png' });
        await page2.screenshot({ path: 'tests/screenshots/dm-call-panel-p2.png' });

        // Navigate page1 to the server while still in DM call
        await page.click(`.server-icon[data-id="${serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 10000 });

        // Screenshot 2: server view with DM call bar at bottom
        await page.screenshot({ path: 'tests/screenshots/dm-call-server-view.png' });

        // Join the voice channel on page1
        await page.click(`.channel-item[data-id="${channelId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });

        // Screenshot 3: server voice channel + DM call bar
        await page.screenshot({ path: 'tests/screenshots/dm-call-with-voice-bar.png' });

        // page2 navigates to server too
        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click(`.server-icon[data-id="${serverId}"]`);
        await page2.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${channelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });

        // Screenshot 4: page2 server view + voice bar
        await page2.screenshot({ path: 'tests/screenshots/dm-call-server-view-p2.png' });
    });
});
