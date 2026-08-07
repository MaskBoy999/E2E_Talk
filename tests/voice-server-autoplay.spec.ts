import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// NOTE: deliberately NO --autoplay-policy=no-user-gesture-required and NO
// --use-fake-device-for-media-stream flag relaxation beyond the fake mic:
// this reproduces the REAL browser autoplay policy. The single voice-channel
// click is a gesture, but the remote <audio> element is created at ontrack
// AFTER that gesture has passed — under strict autoplay, play() is blocked
// unless something retries it (the DM call masks this because accept/ring
// interactions provide extra gestures).
test.use({
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
        ],
    },
});

test.describe('Server voice: strict autoplay policy', () => {

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

    async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
        const ts = Date.now();
        const inviteCode = 'AP' + ts;
        const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, symKey);
            const encName = E2ECrypto.aeadEncrypt('Autoplay Server', symKey);
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
        }, { name: 'Autoplay Voice', serverKeyB64 });

        const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                name: 'Autoplay Voice',
                encrypted_name: encName2.ciphertext,
                name_nonce: encName2.nonce,
                channel_type: 'voice',
            },
        })).json();
        expect(ch.channel_type).toBe('voice');
        return { serverId, voiceChannelId: ch.id, inviteCode };
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

    test('B hears A: remote audio element must be PLAYING under strict autoplay, without any extra click', async ({ page, context }) => {
        test.setTimeout(180000);
        const user1 = 'apa_' + Date.now();
        const user2 = 'apb_' + Date.now();
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);

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

        // A joins and starts talking (fake mic)
        expect(await selectServer(page)).toBe(true);
        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        await page.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });
        await page.waitForTimeout(2000);

        // B joins — single click, no further gestures
        expect(await selectServer(page2)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });
        await page.waitForTimeout(5000);

        // B's remote audio element must EXIST and be PLAYING (not paused).
        // Under strict autoplay the initial play() at ontrack is blocked and
        // nothing retries it in the server flow → el.paused === true.
        const audioState = await page2.evaluate(() => {
            const v = (window as any).VoiceManager;
            // _debug.state is the REAL S (getState() JSON-clones and destroys
            // DOM element prototypes) — inspect the live objects here.
            const s = v._debug && v._debug.state ? v._debug.state : v.getState();
            const rae = s.remoteAudioEls || {};
            const keys = Object.keys(rae);
            const els = Object.values(rae).flat() as any[];
            return {
                connected: s.connected,
                remoteAudioKeys: keys,
                remoteAudioCount: Object.keys(s.remoteStreams || {}).filter((u) => s.remoteStreams[u] && s.remoteStreams[u].audio).length,
                els: els.map((e) => ({
                    tag: e && e.tagName,
                    ctor: e && e.constructor && e.constructor.name,
                    paused: e && e.paused,
                    muted: e && e.muted,
                    volume: e && e.volume,
                    hasSrc: !!(e && e.srcObject),
                    isArray: Array.isArray(e),
                })),
            };
        });
        console.log('AUDIO_STATE:', JSON.stringify(audioState));
        expect(audioState.connected).toBe(true);
        expect(audioState.remoteAudioCount).toBe(1);
        expect(audioState.els.length).toBeGreaterThan(0);
        // THE critical assertion — this is what fails in a real browser:
        const playing = audioState.els.filter((e: any) => !e.paused && e.hasSrc);
        expect(playing.length).toBeGreaterThan(0);

        await page2.close();
        await ctx2.close();
    });
});
