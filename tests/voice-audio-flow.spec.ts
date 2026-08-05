import { test, expect } from '@playwright/test';

// Audio-transport regression for DM calls.
// Headless Chrome CANNOT decode/play WebRTC audio (no audio pipeline — proven
// empirically: a vanilla, same-page WebRTC call receives RTP bytes but decodes
// zero samples), so this test asserts everything that MUST hold for audio to
// work in a real browser, without requiring actual audio playback:
//   1. Both sides acquired a live mic track
//   2. Each side received the other's audio track (ontrack fired, live)
//   3. Peer connections are 'connected' and audio RTP bytes flow BOTH ways
//   4. E2EE room keys agree on both sides (AES-GCM decrypt will succeed)
//   5. No receiver is stranded without a decrypt transform (applyRecvE2EE queue)
//   6. AudioContext is 'running' (created in the Accept gesture)

const BASE = 'https://localhost:3443';

test.use({
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    },
});

test.describe('DM call audio transport', () => {

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

    async function createDm(page: any, page2: any, body1: any, body2: any) {
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

    async function transportDump(page: any) {
        return await page.evaluate(async () => {
            // @ts-ignore
            const V = window.VoiceManager;
            const S = V._debug.state; // LIVE state (getState() JSON-clones and destroys objects)
            const out: any = {
                muted: S.muted,
                connected: S.connected,
                roomKeyB64: S.roomKeyB64,
                audioCtxState: S.audioCtx ? S.audioCtx.state : 'no-ctx',
                pendingRecvTransforms: (S._pendingRecvTransforms || []).length,
                micTracks: S.localStreams && S.localStreams.mic ? S.localStreams.mic.getTracks().map((t: any) => ({ kind: t.kind, state: t.readyState })) : [],
                remoteAudio: {} as any,
                peer: null as any,
            };
            Object.keys(S.remoteStreams || {}).forEach((uid) => {
                const a = S.remoteStreams[uid].audio;
                out.remoteAudio[uid] = a ? a.getTracks().map((t: any) => ({ kind: t.kind, state: t.readyState, muted: t.muted })) : null;
            });
            const uids = Object.keys(S.peers || {});
            if (uids.length) {
                const pc = S.peers[uids[0]];
                out.peer = { conn: pc.connectionState, ice: pc.iceConnectionState };
                const stats: any = {};
                try {
                    const report = await pc.getStats();
                    report.forEach((s: any) => {
                        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                            stats.inboundBytes = s.bytesReceived;
                            stats.inboundPackets = s.packetsReceived;
                        }
                        if (s.type === 'outbound-rtp' && s.kind === 'audio') {
                            stats.outboundBytes = s.bytesSent;
                        }
                    });
                } catch (_) {}
                out.peer.stats = stats;
            }
            return out;
        });
    }

    test('audio transport works end-to-end in a DM call', async ({ browser }) => {
        test.setTimeout(60000);
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        const body1 = await registerUser(page, 'at1_' + Date.now().toString().slice(-6));
        const body2 = await registerUser(page2, 'at2_' + Date.now().toString().slice(-6));
        await waitForWs(page);
        await waitForWs(page2);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await page.reload();
        await page2.reload();
        await waitForWs(page);
        await waitForWs(page2);

        // Caller: real click on the header call button (trusted gesture)
        await openDm(page);
        await page.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 15000 });
        await page.click('.dm-call-btns .dm-call-btn');
        await page.waitForTimeout(1500);

        // Callee: real click on Accept (trusted gesture — this is what unlocks
        // its AudioContext in a real browser)
        await page2.waitForSelector('#incoming-call-accept:visible', { timeout: 15000 });
        await page2.click('#incoming-call-accept');
        await page.waitForTimeout(8000);

        const d1 = await transportDump(page);
        const d2 = await transportDump(page2);
        console.log('=====AUDIO TRANSPORT=====\n' + JSON.stringify({ caller: d1, callee: d2 }, null, 2));

        // Both sides: mic acquired, connected, key derived, ctx running
        expect(d1.connected, 'caller connected').toBe(true);
        expect(d2.connected, 'callee connected').toBe(true);
        expect(d1.micTracks.length, 'caller mic track').toBeGreaterThan(0);
        expect(d2.micTracks.length, 'callee mic track').toBeGreaterThan(0);
        expect(d1.micTracks[0].state, 'caller mic live').toBe('live');
        expect(d2.micTracks[0].state, 'callee mic live').toBe('live');
        expect(d1.audioCtxState, 'caller AudioContext').toBe('running');
        expect(d2.audioCtxState, 'callee AudioContext').toBe('running');

        // E2EE: room keys must AGREE (same AES-GCM key on both ends) and no
        // receiver may be stranded waiting for a decrypt transform.
        expect(d1.roomKeyB64, 'caller room key').toBeTruthy();
        expect(d2.roomKeyB64, 'callee room key').toBeTruthy();
        expect(d1.roomKeyB64, 'room keys agree').toBe(d2.roomKeyB64);
        expect(d1.pendingRecvTransforms, 'caller: no stranded decrypt transforms').toBe(0);
        expect(d2.pendingRecvTransforms, 'callee: no stranded decrypt transforms').toBe(0);

        // Each side received the other's audio track, live and unmuted
        const r1 = Object.values(d1.remoteAudio)[0] as any;
        const r2 = Object.values(d2.remoteAudio)[0] as any;
        expect(r1, 'caller received remote audio').toBeTruthy();
        expect(r2, 'callee received remote audio').toBeTruthy();
        expect(r1[0].state, 'caller remote audio live').toBe('live');
        expect(r2[0].state, 'callee remote audio live').toBe('live');
        expect(r1[0].muted, 'caller remote audio unmuted').toBe(false);
        expect(r2[0].muted, 'callee remote audio unmuted').toBe(false);

        // WebRTC transport live + audio RTP flowing both directions
        expect(d1.peer && d1.peer.conn, 'caller→callee connected').toBe('connected');
        expect(d2.peer && d2.peer.conn, 'callee→caller connected').toBe('connected');
        expect(d1.peer.stats.inboundBytes > 0, 'caller receives audio bytes').toBeTruthy();
        expect(d2.peer.stats.inboundBytes > 0, 'callee receives audio bytes').toBeTruthy();
        expect(d1.peer.stats.outboundBytes > 0, 'caller sends audio bytes').toBeTruthy();
        expect(d2.peer.stats.outboundBytes > 0, 'callee sends audio bytes').toBeTruthy();
    });
});
