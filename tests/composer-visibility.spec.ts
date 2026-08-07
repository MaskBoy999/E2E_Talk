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

async function createServer(page: any, ts: number) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'CV_' + ts);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id'));
    const token = await page.evaluate(() => localStorage.getItem('token'));
    return { serverId, token };
}

async function createChannel(page: any, serverId: string, token: string, name: string, channelType: string) {
    const encName = await page.evaluate(async (nm) => {
        const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')));
        return E2ECrypto.aeadEncrypt(nm, new Uint8Array(k));
    }, name);
    const res = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { encrypted_name: encName.ciphertext, name_nonce: encName.nonce, channel_type: channelType },
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()).id;
}

const composerState = (page: any) => page.evaluate(() => {
    const bar = document.querySelector('.chat-input') as HTMLElement | null;
    const input = document.getElementById('message-input') as HTMLInputElement | null;
    return {
        visible: !!bar && bar.style.display !== 'none',
        inputDisabled: !!(input && input.disabled),
    };
});

async function setupFriendsAndDm(page: any, page2: any, body1: any, body2: any) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    await page.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${body2.token}` },
    })).json();
    await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    return { userData, dm };
}

test.describe('composer (chat-input) visibility', () => {
    test('composer only shows in a text channel or DM conversation', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();

        // --- Phase A: single user, server states ---
        const u1 = await registerUser(page, 'cv1_' + ts);

        // 1. Fresh home (no server selected): composer hidden
        let st = await composerState(page);
        expect(st.visible).toBe(false);
        expect(st.inputDisabled).toBe(true);

        const srv = await createServer(page, ts);
        await page.waitForTimeout(1000);
        // 2. Server home ("Select a channel"): composer hidden
        st = await composerState(page);
        expect(st.visible).toBe(false);

        // Create both channels, then re-select the server so the channel list
        // re-renders from the API with both items.
        const textChId = await createChannel(page, srv.serverId, srv.token, 'general', 'text');
        const voiceChId = await createChannel(page, srv.serverId, srv.token, 'vc', 'voice');
        await page.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${textChId}"]`, { timeout: 10000 });
        await page.waitForSelector(`.channel-item[data-id="${voiceChId}"]`, { timeout: 10000 });

        // 3. Text channel selected: composer visible
        await page.click(`.channel-item[data-id="${textChId}"]`);
        await page.waitForTimeout(800);
        st = await composerState(page);
        expect(st.visible).toBe(true);
        expect(st.inputDisabled).toBe(false);

        // 4. Join a voice channel (text channel stays selected): composer stays
        await page.click(`.channel-item[data-id="${voiceChId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });
        await page.waitForTimeout(1000);
        st = await composerState(page);
        expect(st.visible).toBe(true);

        // 5. Voice channel view open: composer hidden (not a text surface)
        await page.click('#voice-bar-popup').catch(() => {});
        await page.waitForTimeout(800);
        st = await composerState(page);
        expect(st.visible).toBe(false);
        await page.click('#voice-popup-close').catch(() => {});
        await page.waitForTimeout(600);
        st = await composerState(page);
        expect(st.visible).toBe(true);

        // 6. DM home (no conversation): composer hidden
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1200);
        st = await composerState(page);
        expect(st.visible).toBe(false);

        // --- Phase B: two users, DM conversation ---
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const u2 = await registerUser(page2, 'cv2_' + ts);
        const { dm } = await setupFriendsAndDm(page, page2, u1, u2);

        // Reload A so the conversation list populates, then open the DM
        await page.reload();
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page.click('#dm-strip-btn').catch(() => {});
        await page.waitForTimeout(1000);
        let opened = false;
        for (let i = 0; i < 40; i++) {
            const conv = page.locator('.dm-item, .dm-conv, [data-dm-id]');
            if (await conv.count()) {
                await conv.first().click().catch(() => {});
                opened = true;
                break;
            }
            await page.waitForTimeout(300);
        }
        expect(opened).toBe(true);
        await page.waitForTimeout(1000);
        // 7. DM conversation open: composer visible
        st = await composerState(page);
        expect(st.visible).toBe(true);
        expect(st.inputDisabled).toBe(false);

        // 8. Back to DM home (clicking the DM strip re-enters the home
        // surface with "Select a conversation"): composer hidden again
        await page.click('#dm-strip-btn').catch(() => {});
        await page.waitForTimeout(1000);
        st = await composerState(page);
        expect(st.visible).toBe(false);
    });
});
