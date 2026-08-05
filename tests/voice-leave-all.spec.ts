import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('voice_leave_all page-load fallback', () => {
    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(500);
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

    async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
        const ts = Date.now();
        const inviteCode = 'VL' + ts;
        const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, symKey);
            const encName = E2ECrypto.aeadEncrypt('LeaveAll Server', symKey);
            const encCh = E2ECrypto.aeadEncrypt('general', symKey);
            return {
                encrypted_name: encName.ciphertext,
                name_nonce: encName.nonce,
                channel_encrypted_name: encCh.ciphertext,
                channel_name_nonce: encCh.nonce,
                invite_code: inviteCode,
            };
        }, { serverId: 'pending', inviteCode });

        const srv = await (await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
        }, { name: 'General Voice', serverKeyB64 });
        const vc = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                encrypted_name: encName2.ciphertext,
                name_nonce: encName2.nonce,
                channel_type: 'voice',
            },
        })).json();
        await page.evaluate(({ serverId, inviteCode }) => {
            localStorage.setItem('e2e_invite_' + serverId, inviteCode);
        }, { serverId, inviteCode });
        return { serverId, voiceChannelId: vc.id, inviteCode };
    }

    async function selectServer(page: any) {
        await page.evaluate(() => {
            if (typeof loadServers === 'function') loadServers();
        }).catch(() => {});
        await page.click('#dm-strip-btn').catch(() => {});
        await page.waitForTimeout(800);
        for (let i = 0; i < 30; i++) {
            const count = await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
            if (count > 0) {
                await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
                await page.waitForTimeout(600);
                return true;
            }
            await page.waitForTimeout(300);
        }
        return false;
    }

    async function clickVoiceChannel(page: any, channelId: string) {
        for (let i = 0; i < 40; i++) {
            const el = page.locator(`.channel-item[data-id="${channelId}"]`);
            if (await el.count()) {
                await el.click();
                await page.waitForTimeout(600);
                return true;
            }
            await page.waitForTimeout(300);
        }
        return false;
    }

    test('fresh page load leaves stale voice rooms', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'vl1_' + ts;
        const user2 = 'vl2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        const { serverId, voiceChannelId } = await createServerWithVoiceChannel(page, body1.token);

        // User2 joins via the raw invite code (server salts & hashes it on lookup)
        const inviteCode = await page.evaluate((sid) => localStorage.getItem('e2e_invite_' + sid), serverId);
        expect(inviteCode).toBeTruthy();
        const join2 = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join2.ok()).toBeTruthy();

        await page.evaluate(async ({ serverId, user2Id }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.getServerKey(serverId);
            const pubRes = await fetch('/api/identity/' + user2Id, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const pubData = await pubRes.json();
            const u2Pub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
            const enc = E2ECrypto.envelopeEncrypt(symKey, u2Pub, identity.privateKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: user2Id,
                    encrypted_key: enc.ciphertext,
                    sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                    nonce: enc.nonce,
                }),
            });
        }, { serverId, user2Id: body2.user.id });

        await waitForWs(page);
        await waitForWs(page2);
        expect(await selectServer(page)).toBe(true);
        expect(await selectServer(page2)).toBe(true);
        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);

        // Both connected — presence snapshot shows user2 in the room
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && Object.keys(v._debug.state.members).length >= 2;
        }, undefined, { timeout: 15000 });

        // Instrument: capture any voice_leave_all sent on the fresh page load
        // (addInitScript survives the reload; plain evaluate would be wiped).
        await page2.addInitScript(() => {
            (window as any)._sentLeaveAll = false;
            const origSend = WebSocket.prototype.send;
            window.WebSocket.prototype.send = function (data: any) {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'voice_leave_all') (window as any)._sentLeaveAll = true;
                } catch (_) {}
                return origSend.call(this, data);
            };
        });

        // User2 reloads the page
        await page2.reload();
        await page2.waitForURL('**/index.html', { timeout: 15000 });
        await waitForWs(page2);
        await page2.waitForTimeout(2500);

        // The fresh page must have sent voice_leave_all
        const sentLeaveAll = await page2.evaluate(() => (window as any)._sentLeaveAll === true);
        expect(sentLeaveAll).toBeTruthy();

        // User2 must NOT be in the voice room anymore: VoiceManager state is fresh
        const freshState = await page2.evaluate(() => {
            const v = window.VoiceManager;
            return { connected: v.isConnected(), inDmCall: v.isInDmCall() };
        });
        expect(freshState.connected).toBe(false);
        expect(freshState.inDmCall).toBe(false);

        // And the OWNER's presence snapshot must no longer list user2 in the channel
        await page.waitForTimeout(1500);
        const ownerPresence = await page.evaluate(({ serverId, uid }) => {
            const v = window.VoiceManager;
            const p = v._debug.getServerPresence(serverId);
            if (!p || !p.channels) return null;
            for (const ch of p.channels) {
                if ((ch.members || []).some((m: any) => m.user_id === uid)) {
                    return ch.members.map((m: any) => m.user_id);
                }
            }
            return [];
        }, { serverId, uid: body2.user.id });
        expect(ownerPresence).toEqual([]);

        await ctx2.close();
    });
});
