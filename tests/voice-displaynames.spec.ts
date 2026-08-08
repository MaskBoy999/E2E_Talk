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

// Seed the decrypted profile cache (the exact source voice.js reads) with a
// display name + color + glow for a partner, mirroring what the profile
// decryption pipeline would have stored.
async function seedDisplayName(page: any, uid: string, displayName: string, color: string, border: string) {
    return await page.evaluate(({ uid, displayName, color, border }) => {
        (window as any).userDisplayNameCache = (window as any).userDisplayNameCache || {};
        (window as any).userDisplayNameCache[uid] = (window as any).userDisplayNameCache[uid] || {};
        (window as any).userDisplayNameCache[uid].display_name = displayName;
        (window as any).userDisplayNameCache[uid].username_color = color;
        (window as any).userDisplayNameCache[uid].username_border_color = border;
        return true;
    }, { uid, displayName, color, border });
}

async function profileModalLoaded(page: any) {
    await page.waitForFunction(() => {
        const el = document.getElementById('profile-modal-display-name');
        return el && el.textContent && el.textContent !== 'Loading...' && el.textContent !== 'User not found';
    }, { timeout: 15000 });
}

test.describe('Voice display names: color/glow + pfp click opens profile', () => {

    test('DM call: colored display names in panel/mini-bar/incoming bar, pfp click opens profile', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'vdn1_' + ts;
        const user2 = 'vdn2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);

        await waitForWs(page);
        await waitForWs(page2);

        await openDm(page);

        // Partner colors: A sees B as orange, B sees A as cyan.
        await seedDisplayName(page, userData.id, 'B-Color', '#ff6600', 'rgba(255,0,0,0.9)');
        await seedDisplayName(page2, body1.user.id, 'A-Color', '#00ccff', '#0044ff');

        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });

        // A starts the call → A's panel shows "Calling <colored B>…"
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });

        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
        const callerNameStyle = await page.evaluate(() => {
            const name = document.getElementById('dm-call-name');
            if (!name) return null;
            const span = name.querySelector('span');
            if (!span) return null;
            return { text: name.textContent, color: span.style.color, shadow: span.style.textShadow };
        });
        expect(callerNameStyle).not.toBeNull();
        expect(callerNameStyle!.text).toContain('B-Color');
        expect(callerNameStyle!.color).toBe('rgb(255, 102, 0)');
        expect(callerNameStyle!.shadow).toContain('rgba(255, 0, 0, 0.9)');

        // B sees the incoming bar with the colored caller name.
        await page2.waitForSelector('#incoming-call-bar', { state: 'visible', timeout: 15000 });
        const incomingNameStyle = await page2.evaluate(() => {
            const name = document.getElementById('incoming-call-name');
            if (!name) return null;
            const span = name.querySelector('span');
            if (!span) return null;
            return { text: name.textContent, color: span.style.color, shadow: span.style.textShadow };
        });
        expect(incomingNameStyle).not.toBeNull();
        expect(incomingNameStyle!.text).toContain('A-Color');
        expect(incomingNameStyle!.color).toBe('rgb(0, 204, 255)');

        // B accepts → both connect → the DM call tile shows B's colored name on A's page.
        await page2.click('#incoming-call-accept');
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.getCallState && v.getCallState !== null;
        }, undefined, { timeout: 20000 }).catch(() => {});
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected();
        }, undefined, { timeout: 20000 });

        await page.waitForSelector('#dm-call-panel .dm-call-tile', { state: 'visible', timeout: 15000 });
        const tileNameStyle = await page.evaluate(() => {
            const span = document.querySelector('#dm-call-body .dm-call-tile-info span');
            if (!span) return null;
            return { color: (span as HTMLElement).style.color, shadow: (span as HTMLElement).style.textShadow };
        });
        expect(tileNameStyle).not.toBeNull();
        expect(tileNameStyle!.color).toBe('rgb(255, 102, 0)');
        expect(tileNameStyle!.shadow).toContain('rgba(255, 0, 0, 0.9)');

        // B's side shows A's colored name in its tile.
        await page2.waitForSelector('#dm-call-panel .dm-call-tile', { state: 'visible', timeout: 15000 });
        const tile2NameStyle = await page2.evaluate(() => {
            const span = document.querySelector('#dm-call-body .dm-call-tile-info span');
            if (!span) return null;
            return { color: (span as HTMLElement).style.color, shadow: (span as HTMLElement).style.textShadow };
        });
        expect(tile2NameStyle).not.toBeNull();
        expect(tile2NameStyle!.color).toBe('rgb(0, 204, 255)');

        // Click B's pfp on A's side → profile view opens.
        await page.click('#dm-call-body .dm-call-avatar');
        await page.waitForSelector('#profile-modal', { state: 'visible', timeout: 10000 });
        await profileModalLoaded(page);
        const modalName = await page.evaluate(() => document.getElementById('profile-modal-display-name')!.textContent);
        expect(modalName).toBe(user2);
    });

    test('server voice channel: colored names in popup rows + channel-list chips, pfp click opens profile', async ({ page, context }) => {
        test.setTimeout(240000);
        const user1 = 'vsd1_' + Date.now();
        const user2 = 'vsd2_' + Date.now();
        const body1 = await registerUser(page, user1);

        // Create a server with a voice channel (same encrypted flow as other tests).
        const inviteCode = 'VSD' + Date.now();
        const prep = await page.evaluate(async ({ inviteCode }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey('pending', symKey);
            const encName = E2ECrypto.aeadEncrypt('Voice Names Server', symKey);
            const encCh = E2ECrypto.aeadEncrypt('general', symKey);
            return {
                encrypted_name: encName.ciphertext,
                name_nonce: encName.nonce,
                channel_encrypted_name: encCh.ciphertext,
                channel_name_nonce: encCh.nonce,
                invite_code: inviteCode,
            };
        }, { inviteCode });

        const srv = await (await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: {
                invite_code: inviteCode,
                encrypted_name: prep.encrypted_name,
                name_nonce: prep.name_nonce,
                channel_encrypted_name: prep.channel_encrypted_name,
                channel_name_nonce: prep.channel_name_nonce,
            },
        })).json();
        const serverId = srv.id;
        await page.evaluate(async ({ serverId }) => {
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, symKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
            const pubRes = await fetch('/api/identity/' + myId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const pubData = await pubRes.json();
            const pubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
            const enc = E2ECrypto.envelopeEncrypt(symKey, pubKey, identity.privateKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: myId,
                    encrypted_key: enc.ciphertext,
                    sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                    nonce: enc.nonce,
                }),
            });
        }, { serverId });

        const serverKeyB64 = await page.evaluate((sid) => {
            const sk = E2ECrypto.getServerKey(sid);
            return E2ECrypto.arrayBufferToBase64(sk);
        }, serverId);
        const encName2 = await page.evaluate(async ({ name, serverKeyB64 }) => {
            const sk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(serverKeyB64));
            const enc = E2ECrypto.aeadEncrypt(name, sk);
            return { ciphertext: enc.ciphertext, nonce: enc.nonce };
        }, { name: 'Voice Names VC', serverKeyB64 });

        const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: {
                name: 'Voice Names VC',
                encrypted_name: encName2.ciphertext,
                name_nonce: encName2.nonce,
                channel_type: 'voice',
            },
        })).json();
        expect(ch.channel_type).toBe('voice');
        const voiceChannelId = ch.id;

        // B joins the server.
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const join = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();

        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2500);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2500);
        await waitForWs(page);
        await waitForWs(page2);

        async function selectServer(pg: any) {
            await pg.evaluate(() => {
                if (typeof loadServers === 'function') loadServers();
            }).catch(() => {});
            await pg.click('#dm-strip-btn').catch(() => {});
            await pg.waitForTimeout(800);
            for (let i = 0; i < 30; i++) {
                const count = await pg.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
                if (count > 0) {
                    await pg.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
                    await pg.waitForTimeout(600);
                    return true;
                }
                await pg.waitForTimeout(300);
            }
            return false;
        }

        async function clickVoiceChannel(pg: any, channelId: string) {
            for (let i = 0; i < 40; i++) {
                const el = pg.locator(`.channel-item[data-id="${channelId}"]`);
                if (await el.count()) {
                    await el.click();
                    await pg.waitForTimeout(600);
                    return true;
                }
                await pg.waitForTimeout(300);
            }
            return false;
        }

        expect(await selectServer(page)).toBe(true);
        await page.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });
        expect(await selectServer(page2)).toBe(true);
        await page2.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });

        // Both join the voice channel.
        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);

        // Wait until both sides see 2 members in the room.
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && Object.keys(v._debug.getMembers()).length >= 2;
        }, undefined, { timeout: 30000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && Object.keys(v._debug.getMembers()).length >= 2;
        }, undefined, { timeout: 30000 });

        // Seed colors: A sees B as orange, B sees A as cyan.
        await seedDisplayName(page, body2.user.id, 'B-Server', '#ff6600', 'rgba(255,0,0,0.9)');
        await seedDisplayName(page2, body1.user.id, 'A-Server', '#00ccff', '#0044ff');

        // Open the voice channel view on A's side → popup rows must be colored.
        await page.evaluate(() => { window.VoiceManager.navigateToVoiceChannel(); });
        await page.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });
        await page.waitForSelector('#voice-popup .voice-member-row', { state: 'visible', timeout: 10000 });

        const rowNameStyle = await page.evaluate((otherId) => {
            const row = document.querySelector(`#voice-popup .voice-member-row[data-uid="${otherId}"]`);
            if (!row) return null;
            const span = row.querySelector('.voice-member-name');
            if (!span) return null;
            return { color: (span as HTMLElement).style.color, shadow: (span as HTMLElement).style.textShadow };
        }, body2.user.id);
        expect(rowNameStyle).not.toBeNull();
        expect(rowNameStyle!.color).toBe('rgb(255, 102, 0)');
        expect(rowNameStyle!.shadow).toContain('rgba(255, 0, 0, 0.9)');

        // B's side sees A's colored name in the popup.
        await page2.evaluate(() => { window.VoiceManager.navigateToVoiceChannel(); });
        await page2.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });
        await page2.waitForSelector('#voice-popup .voice-member-row', { state: 'visible', timeout: 10000 });
        const row2NameStyle = await page2.evaluate((otherId) => {
            const row = document.querySelector(`#voice-popup .voice-member-row[data-uid="${otherId}"]`);
            if (!row) return null;
            const span = row.querySelector('.voice-member-name');
            if (!span) return null;
            return { color: (span as HTMLElement).style.color, shadow: (span as HTMLElement).style.textShadow };
        }, body1.user.id);
        expect(row2NameStyle).not.toBeNull();
        expect(row2NameStyle!.color).toBe('rgb(0, 204, 255)');

        // Channel-list chips also carry the color (Discord-style presence).
        // Chips re-render on presence events, so force one now that the cache
        // is seeded, then wait for the SPECIFIC chip (not the self chip, which
        // carries the user's own default color).
        await page.evaluate(() => { window.VoiceManager.updateChannelChips(); });
        await page.waitForFunction((otherId) => {
            const row = document.querySelector(`.voice-chip-row[data-uid="${otherId}"]`);
            if (!row) return false;
            const s = row.querySelector('.voice-chip-name') as HTMLElement | null;
            return !!(s && s.style.color === 'rgb(255, 102, 0)');
        }, body2.user.id, { timeout: 10000 });
        const chipStyle = await page.evaluate((otherId) => {
            const row = document.querySelector(`.voice-chip-row[data-uid="${otherId}"]`);
            if (!row) return null;
            const span = row.querySelector('.voice-chip-name');
            if (!span) return null;
            return { color: (span as HTMLElement).style.color, shadow: (span as HTMLElement).style.textShadow };
        }, body2.user.id);
        expect(chipStyle).not.toBeNull();
        expect(chipStyle!.color).toBe('rgb(255, 102, 0)');
        expect(chipStyle!.shadow).toContain('rgba(255, 0, 0, 0.9)');

        // Click B's pfp in the voice channel view → profile view opens.
        await page.click(`#voice-popup .voice-member-row[data-uid="${body2.user.id}"] .voice-member-avatar`);
        await page.waitForSelector('#profile-modal', { state: 'visible', timeout: 10000 });
        await profileModalLoaded(page);
        const modalName = await page.evaluate(() => document.getElementById('profile-modal-display-name')!.textContent);
        expect(modalName).toBe(user2);
    });
});
