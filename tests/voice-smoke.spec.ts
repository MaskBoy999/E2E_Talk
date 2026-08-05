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
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                    resolve(true);
                } else if (tries >= maxRetries) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
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

test.describe('Voice channels & calls (protocol smoke)', () => {

    test('voice channel: create, join, members sync, owner sanctions persist', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push('OWNER PAGEERROR: ' + err.message));
        const owner = await registerUser(page, 'voiceown_' + ts);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const memErrors: string[] = [];
        page2.on('pageerror', (err) => memErrors.push('MEMBER PAGEERROR: ' + err.message));
        const member = await registerUser(page2, 'voicemem_' + ts);
        await becomeFriends(page, page2, owner.token, member.token);

        // Owner creates a server
        await page.click('#add-server-btn');
        await page.click('#choice-create-server');
        await page.fill('#new-server-name', 'VoiceTest_' + ts);
        await page.click('#confirm-create-server');
        await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
        const serverId = await page.evaluate(() => {
            const el = document.querySelector('.server-icon[data-id]');
            return el ? el.getAttribute('data-id') : null;
        });
        expect(serverId).toBeTruthy();

        // Owner creates a VOICE channel via the API
        const serverKey = await page.evaluate((sid) => {
            return localStorage.getItem('e2e_server_' + sid);
        }, serverId);
        expect(serverKey).toBeTruthy();
        const encName = await page.evaluate(async (name) => {
            const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + document.querySelector('.server-icon[data-id]').getAttribute('data-id')));
            return E2ECrypto.aeadEncrypt(name, new Uint8Array(k));
        }, 'General');

        const createCh = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
            data: { encrypted_name: encName.ciphertext, name_nonce: encName.nonce, channel_type: 'voice' },
        });
        expect(createCh.ok()).toBeTruthy();
        const chJson = await createCh.json();
        expect(chJson.channel_type).toBe('voice');
        const channelId = chJson.id;

        // Second member joins the server via invite
        const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
        const invRes = await page.request.post(`${BASE}/api/servers/${serverId}/invite`, {
            headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: code },
        });
        expect(invRes.ok()).toBeTruthy();
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
            data: { code: code },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Both open the server and click the voice channel → join
        await page.click(`.server-icon[data-id="${serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 10000 });
        await page.click(`.channel-item[data-id="${channelId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });

        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click('.server-icon[data-id="' + serverId + '"]');
        await page2.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${channelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });

        // Member list should now contain 2 members (via WS voice_members → the
        // channel-list chips re-render with .voice-chip-row entries)
        try {
            await page.waitForFunction((chId) => {
                const chips = document.querySelectorAll('.channel-item[data-id="' + chId + '"] .voice-chip-row');
                return chips.length >= 1;
            }, channelId, { timeout: 10000 });
        } catch (e) {
            const state = await page.evaluate((chId) => {
                const ch = document.querySelector('.channel-item[data-id="' + chId + '"]');
                return {
                    channelExists: !!ch,
                    channelHTML: ch ? ch.outerHTML.slice(0, 400) : null,
                    voiceBar: !!document.getElementById('voice-bar'),
                    room: window.VoiceManager ? window.VoiceManager.getState() : 'noVM',
                };
            }, channelId);
            console.log('DIAG owner state:', JSON.stringify(state));
            console.log('DIAG owner errors:', JSON.stringify(pageErrors));
            throw e;
        }

        // Owner force-mutes the member via ownerControl (the real API path)
        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('mute', uid);
        }, { uid: member.user.id });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.getState().forceMuted === true;
        }, undefined, { timeout: 10000 });

        // The member's bar mute button becomes locked (.locked class)
        const locked = await page2.evaluate(() => {
            const b = document.getElementById('voice-bar-mute');
            return b ? b.classList.contains('locked') : false;
        });
        expect(locked).toBe(true);

        // Sanction persists: reload member page, rejoin, still force-muted
        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click('.server-icon[data-id="' + serverId + '"]');
        await page2.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${channelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.getState().forceMuted === true;
        }, undefined, { timeout: 10000 });
        const lockedAfterReload = await page2.evaluate(() => {
            const b = document.getElementById('voice-bar-mute');
            return b ? b.classList.contains('locked') : false;
        });
        expect(lockedAfterReload).toBe(true);

        // Owner kicks the member
        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('kick', uid);
        }, { uid: member.user.id });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() === false;
        }, undefined, { timeout: 10000 });

        // They can rejoin
        await page2.click(`.channel-item[data-id="${channelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });
        const rejoined = await page2.evaluate(() => {
            const v = window.VoiceManager;
            return v && v.isConnected();
        });
        expect(rejoined).toBe(true);

        // Owner clears the mute sanction; member can now unmute
        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('unmute', uid);
        }, { uid: member.user.id });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.getState().forceMuted === false;
        }, undefined, { timeout: 10000 });
        const unlocked = await page2.evaluate(() => {
            const b = document.getElementById('voice-bar-mute');
            return b ? !b.classList.contains('locked') : false;
        });
        expect(unlocked).toBe(true);
    });

    test('dm call: start via header button, accept, both connect, end call', async ({ context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        // Use FRESH contexts for BOTH participants — the shared `page` fixture
        // carries over state from the previous test (active voice room, WS,
        // timers) which made the ring delivery flaky when run after it.
        const ctx1 = await context.browser()!.newContext();
        const page = await ctx1.newPage();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push('P1 PAGEERROR: ' + err.message));
        const u1 = await registerUser(page, 'dmcall1_' + ts);
        const memErrors: string[] = [];
        page2.on('pageerror', (err) => memErrors.push('P2 PAGEERROR: ' + err.message));
        const u2 = await registerUser(page2, 'dmcall2_' + ts);
        await becomeFriends(page, page2, u1.token, u2.token);
        // The ring is sent once over the WS and never re-delivered — both sides
        // must be connected BEFORE the call starts or P2 misses it forever.
        await waitForWs(page);
        await waitForWs(page2);

        // Open DM view on both, wait for the DM item to appear
        await page.click('#dm-strip-btn');
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        await page.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 10000 });

        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item', { timeout: 15000 });
        await page2.click('.dm-item');
        await page2.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 10000 });

        // P1 starts the call via the header call button
        await page.click('.dm-call-btns .dm-call-btn');
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // P2 receives the ring (state first — more reliable under parallel
        // load than the bar's visibility) and accepts.
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 20000 });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 15000 });
        await page2.click('#incoming-call-accept');
        await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // Both sides connected
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 15000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 15000 });

        // P1 hangs up — their side exits; P2 stays in the call (waiting state).
        // The waiting flip arrives via server round-trip (voice_member_leave →
        // voice_members → dm_call_waiting), so WAIT for it rather than checking
        // immediately.
        await page.click('#dm-call-end');
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && !v.isInDmCall();
        }, undefined, { timeout: 10000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isInDmCall() && v.isCallWaiting();
        }, undefined, { timeout: 10000 });

        // P2 then ends the call themselves
        await page2.click('#dm-call-end');
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && !v.isInDmCall();
        }, undefined, { timeout: 10000 });

        // No uncaught errors on either page
        expect(pageErrors).toEqual([]);
        expect(memErrors).toEqual([]);
    });
});
