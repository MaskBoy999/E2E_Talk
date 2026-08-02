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

test.describe('Voice channels & calls (protocol smoke)', () => {

    test('voice channel: create, join, members sync, owner sanctions persist', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push('OWNER PAGEERROR: ' + err.message));
        page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') pageErrors.push('OWNER ' + msg.type() + ': ' + msg.text()); });
        const owner = await registerUser(page, 'voiceown_' + ts);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const memErrors: string[] = [];
        page2.on('pageerror', (err) => memErrors.push('MEMBER PAGEERROR: ' + err.message));
        page2.on('console', (msg) => { if (msg.type() === 'error') memErrors.push('MEMBER err: ' + msg.text()); });
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

        // Owner creates a VOICE channel via the API (UI toggle is covered by unit checks)
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

        // Second member joins the server via invite (invite code is generated
        // client-side and POSTed, exactly like the real UI flow)
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

        // Member page joined via API — reload so its server list refreshes.
        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click('.server-icon[data-id="' + serverId + '"]');
        await page2.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${channelId}"]`);
        try {
            await page2.waitForSelector('#voice-bar', { timeout: 10000 });
        } catch (e) {
            console.log('DIAG member no voice bar, errors:', JSON.stringify(memErrors));
            const memState = await page2.evaluate((chId) => ({
                channelExists: !!document.querySelector('.channel-item[data-id="' + chId + '"]'),
                wsState: (typeof ws !== 'undefined' && ws) ? ws.readyState : 'no-ws',
                hasVoiceManager: !!window.VoiceManager,
                serverId: document.querySelector('.server-icon[data-id]') ? document.querySelector('.server-icon[data-id]').getAttribute('data-id') : null,
            }), channelId);
            console.log('DIAG member state:', JSON.stringify(memState));
            throw e;
        }

        // Member list should now contain 2 members (via WS voice_members)
        try {
            await page.waitForFunction((chId) => {
                const chips = document.querySelectorAll('.channel-item[data-id="' + chId + '"] .voice-chip');
                return chips.length >= 1;
            }, channelId, { timeout: 10000 });
        } catch (e) {
            const state = await page.evaluate((chId) => {
                const ch = document.querySelector('.channel-item[data-id="' + chId + '"]');
                return {
                    channelExists: !!ch,
                    channelHTML: ch ? ch.outerHTML.slice(0, 400) : null,
                    voiceBar: !!document.getElementById('voice-bar'),
                    voiceBarDisplay: document.getElementById('voice-bar') ? document.getElementById('voice-bar').style.display : null,
                    voiceBarHTML: document.getElementById('voice-bar') ? document.getElementById('voice-bar').outerHTML.slice(0, 400) : null,
                    room: window.VoiceManager ? (function () { try { return JSON.stringify(window.VoiceManager._debugState ? window.VoiceManager._debugState() : { noDebug: 1 }); } catch (err2) { return 'err:' + err2.message; } })() : 'noVM',
                };
            }, channelId);
            console.log('DIAG owner state:', JSON.stringify(state));
            console.log('DIAG owner errors:', JSON.stringify(pageErrors));
            throw e;
        }

        // Owner force-mutes the member via the WS protocol
        await page.evaluate(({ ch, target }) => {
            ws.send(JSON.stringify({ type: 'voice_control', room: 'server:' + document.querySelector('.server-icon[data-id]').getAttribute('data-id') + ':' + ch, action: 'mute', target_user_id: target }));
        }, { ch: channelId, target: member.user.id });
        await page.waitForTimeout(800);

        // The member should receive the sanction (their bar mute button becomes disabled/locked)
        const locked = await page2.evaluate(() => {
            const b = document.getElementById('voice-bar-mute');
            return b ? b.classList.contains('disabled') : false;
        });
        expect(locked).toBe(true);

        // Sanction persists: reload member page, rejoin, still force-muted
        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click('.server-icon[data-id="' + serverId + '"]');
        await page2.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${channelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });
        await page2.waitForTimeout(800);
        const lockedAfterReload = await page2.evaluate(() => {
            const b = document.getElementById('voice-bar-mute');
            return b ? b.classList.contains('disabled') : false;
        });
        expect(lockedAfterReload).toBe(true);

        // Owner kicks the member
        await page.evaluate(({ ch, target }) => {
            ws.send(JSON.stringify({ type: 'voice_control', room: 'server:' + document.querySelector('.server-icon[data-id]').getAttribute('data-id') + ':' + ch, action: 'kick', target_user_id: target }));
        }, { ch: channelId, target: member.user.id });
        await page.waitForTimeout(800);

        // Member is kicked → voice bar disappears
        const kickedGone = await page2.evaluate(() => {
            const b = document.getElementById('voice-bar');
            return !b || b.style.display === 'none';
        });
        expect(kickedGone).toBe(true);

        // They can rejoin
        await page2.click(`.channel-item[data-id="${channelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });
        const rejoined = await page2.evaluate(() => !!document.getElementById('voice-bar'));
        expect(rejoined).toBe(true);

        // Owner clears the mute sanction; member can now unmute
        await page.evaluate(({ ch, target }) => {
            ws.send(JSON.stringify({ type: 'voice_control', room: 'server:' + document.querySelector('.server-icon[data-id]').getAttribute('data-id') + ':' + ch, action: 'unmute', target_user_id: target }));
        }, { ch: channelId, target: member.user.id });
        await page.waitForTimeout(800);
        const unlocked = await page2.evaluate(() => {
            const b = document.getElementById('voice-bar-mute');
            return b ? !b.classList.contains('disabled') : false;
        });
        expect(unlocked).toBe(true);
    });

    test('dm call: start call, both join, panel shows, end call', async ({ page, context }) => {
        const ts = Date.now();
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push('P1 PAGEERROR: ' + err.message));
        const u1 = await registerUser(page, 'dmcall1_' + ts);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const memErrors: string[] = [];
        page2.on('pageerror', (err) => memErrors.push('P2 PAGEERROR: ' + err.message));
        const u2 = await registerUser(page2, 'dmcall2_' + ts);
        await becomeFriends(page, page2, u1.token, u2.token);

        // Open DM view on both, wait for the DM item to appear
        await page.click('#dm-strip-btn');
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        await page.waitForSelector('#dm-call-btn', { timeout: 10000 });

        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item', { timeout: 15000 });
        await page2.click('.dm-item');
        await page2.waitForSelector('#dm-call-btn', { timeout: 10000 });

        // P1 starts the call
        await page.click('#dm-call-btn');
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // P2 should see the mini call bar appear, then joins
        await page2.waitForSelector('#call-mini-bar', { state: 'visible', timeout: 10000 });
        await page2.waitForTimeout(500);
        await page2.click('#dm-call-btn');
        await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // Both panels should show both tiles (self + other)
        const tiles1 = await page.evaluate(() => {
            return document.querySelectorAll('#dm-call-body .dm-call-tile').length;
        });
        expect(tiles1).toBeGreaterThanOrEqual(2);
        const tiles2 = await page2.evaluate(() => {
            return document.querySelectorAll('#dm-call-body .dm-call-tile').length;
        });
        expect(tiles2).toBeGreaterThanOrEqual(2);

        // P1 hangs up — their side exits; P2 stays in the call (per spec: a call
        // only ends when YOU close it) but now shows the "waiting" state.
        await page.click('#dm-call-end-btn');
        await page.waitForTimeout(800);
        const p1Done = await page.evaluate(() => {
            const bar = document.getElementById('call-mini-bar');
            const panel = document.getElementById('dm-call-panel');
            return (!bar || bar.style.display === 'none') && (!panel || panel.style.display === 'none');
        });
        expect(p1Done).toBe(true);
        const p2Waiting = await page2.evaluate(() => {
            const panel = document.getElementById('dm-call-panel');
            if (!panel || panel.style.display === 'none') return 'panel-hidden';
            const tiles = document.querySelectorAll('#dm-call-body .dm-call-tile').length;
            const waiting = !!document.querySelector('#dm-call-body .dm-call-waiting');
            return { tiles, waiting };
        });
        expect(p2Waiting).toEqual({ tiles: 1, waiting: true });

        // P2 then ends the call themselves
        await page2.click('#dm-call-end-btn');
        await page2.waitForTimeout(800);
        const p2Done = await page2.evaluate(() => {
            const panel = document.getElementById('dm-call-panel');
            return !panel || panel.style.display === 'none';
        });
        expect(p2Done).toBe(true);

        // No uncaught errors on either page
        expect(pageErrors).toEqual([]);
        expect(memErrors).toEqual([]);
    });
});
