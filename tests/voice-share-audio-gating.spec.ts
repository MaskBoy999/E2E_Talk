import { test, expect } from '@playwright/test';

// E2E_TEST_BASE_URL lets the suite run against a second, isolated server
// instance (its own DB and raised rate limits) without disturbing a dev server.
const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

// Mocked media: getUserMedia returns an oscillator mic + a canvas camera;
// getDisplayMedia returns a canvas screen with an oscillator AUDIO track so
// share-screen audio can be asserted end-to-end.
async function mockMedia(page: any) {
    await page.addInitScript(() => {
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints: any) => {
            if (constraints && constraints.audio) {
                const ac = new (window as any).AudioContext();
                const osc = ac.createOscillator();
                osc.frequency.value = 300;
                const dest = ac.createMediaStreamDestination();
                osc.connect(dest);
                osc.start();
                (window as any).__mockOsc = osc;
                return dest.stream;
            }
            if (constraints && constraints.video) {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                const ctx = canvas.getContext('2d')!;
                let i = 0;
                (window as any).__mockCanvasTimer = setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                const stream = (canvas as any).captureStream(10);
                return stream;
            }
            return origGUM(constraints);
        };
        // Screen share: canvas video + oscillator audio (like a tab with sound).
        navigator.mediaDevices.getDisplayMedia = async (constraints: any) => {
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 360;
            const ctx = canvas.getContext('2d')!;
            let i = 0;
            (window as any).__mockScreenTimer = setInterval(() => {
                ctx.fillStyle = `rgb(50,${(i * 30) % 255},200)`;
                ctx.fillRect(0, 0, 640, 360);
                ctx.fillStyle = '#000';
                ctx.fillText('SCREEN ' + String(i++), 20, 30);
            }, 80);
            const vStream = (canvas as any).captureStream(10);
            const ac = new (window as any).AudioContext();
            const osc = ac.createOscillator();
            osc.frequency.value = 440;
            const dest = ac.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();
            (window as any).__mockScreenOsc = osc;
            vStream.addTrack(dest.stream.getAudioTracks()[0]);
            return vStream;
        };
    });
}

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
    return await page.evaluate(() => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= 60) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    });
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

async function startDmCall(page: any, page2: any, dm: any, partnerUid: string, partnerName: string) {
    await page.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && typeof v.startDmCall === 'function';
    }, undefined, { timeout: 15000 });
    await page.evaluate(({ dmId, uid, uname }) => {
        window.VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: partnerUid, uname: partnerName });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
}

// Wait until the sender's peer to `uid` has an audio sender whose held track
// id equals `trackId` (the screen-audio track), in the given gated state.
async function waitScreenAudioSenderGate(page: any, uid: string, trackId: string, gated: boolean) {
    try {
        await page.waitForFunction(({ uid, trackId, gated }) => {
            const gates = (window as any).VoiceManager._debug.senderGates(uid) || [];
            return gates.some((g: any) => g.kind === 'audio' && g.id === trackId && g.gated === gated);
        }, { uid, trackId, gated }, { timeout: 20000 });
    } catch (e: any) {
        const dump = await page.evaluate((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            return {
                gates: (window as any).VoiceManager._debug.senderGates(uid),
                screenOn: s.screenOn,
                hasScreenStream: !!(s.localStreams && s.localStreams.screen),
                screenAudioTrack: s.localStreams && s.localStreams.screen && s.localStreams.screen.getAudioTracks()[0]
                    ? s.localStreams.screen.getAudioTracks()[0].id : null,
            };
        }, uid);
        console.log('=====SCREEN-AUDIO GATE TIMEOUT DUMP=====\n' + JSON.stringify(dump, null, 2));
        throw e;
    }
}

// The receiver's screen-audio playback elements for a uid (stacked <audio> els).
async function screenAudioElCount(page: any, uid: string): Promise<number> {
    return await page.evaluate((uid) => {
        const s = (window as any).VoiceManager._debug.state;
        const els = s.remoteScreenAudioEls && s.remoteScreenAudioEls[uid];
        return els ? els.length : 0;
    }, uid);
}

test.describe('share-screen audio gating + danger-button text + live profile refresh', () => {

    test('DM call: unloading the screen silences its audio on the receiver AND gates the screen-audio sender; reload resumes both', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'vsaga1_' + ts;
        const user2 = 'vsaga2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, user2);

        // A starts sharing their screen (canvas video + oscillator audio).
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen && s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });

        // A's screen-audio track id (what A sends as the screen audio).
        const screenAudioTrackId = await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.localStreams.screen.getAudioTracks()[0].id;
        });

        // B receives + plays the share audio (elements exist), A sends it ungated.
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            return !!(s.remoteStreams[uid] && s.remoteStreams[uid].screenAudio) &&
                (s.remoteScreenAudioEls[uid] || []).length >= 1;
        }, body1.user.id, { timeout: 20000 });
        await waitScreenAudioSenderGate(page, body2.user.id, screenAudioTrackId, false);

        // B unloads the screen feed → receiver silences it AND sender gates it.
        await page2.evaluate((uid) => (window as any).VoiceManager._debug.unloadFeed(uid, 'screen'), body1.user.id);
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            return !(s.remoteScreenAudioEls[uid] || []).length;
        }, body1.user.id, { timeout: 10000 });
        await waitScreenAudioSenderGate(page, body2.user.id, screenAudioTrackId, true);

        // B clicks Load → playback resumes + sender ungates again.
        await page2.click('.dm-call-tile .voice-feed-load-btn');
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            return (s.remoteScreenAudioEls[uid] || []).length >= 1;
        }, body1.user.id, { timeout: 10000 });
        await waitScreenAudioSenderGate(page, body2.user.id, screenAudioTrackId, false);
        await ctx2.close();
    });

    test('DM call: with manual-load ON, the share audio is held (no playback, sender gated) until Load is clicked', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'vsagb1_' + ts;
        const user2 = 'vsagb2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, user2);

        // B enables manual load BEFORE A shares.
        await page2.evaluate(() => (window as any).VoiceManager.setManualVideoLoad(true));
        await page2.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.settings.manualVideoLoad === true;
        }, undefined, { timeout: 10000 });

        // A shares screen → B holds it behind Load (video AND audio silent).
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen && s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });
        const screenAudioTrackId = await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.localStreams.screen.getAudioTracks()[0].id;
        });

        // B: held behind Load button, NO screen audio elements.
        await page2.waitForSelector('.dm-call-tile .voice-feed-load-btn', { state: 'visible', timeout: 15000 });
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            return !(s.remoteScreenAudioEls[uid] || []).length;
        }, body1.user.id, { timeout: 10000 });
        // A: screen-audio sender gated (B isn't watching the share).
        await waitScreenAudioSenderGate(page, body2.user.id, screenAudioTrackId, true);

        // B clicks Load → both directions resume.
        await page2.click('.dm-call-tile .voice-feed-load-btn');
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            return (s.remoteScreenAudioEls[uid] || []).length >= 1;
        }, body1.user.id, { timeout: 10000 });
        await waitScreenAudioSenderGate(page, body2.user.id, screenAudioTrackId, false);
        await ctx2.close();
    });

    test('Security tab: danger buttons show white text on the red background (no red-on-red)', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'danger_' + ts);
        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="security-settings"]');
        await page.waitForSelector('#kick-all-devices-btn', { state: 'visible', timeout: 10000 });

        const kickColor = await page.evaluate(() => {
            const el = document.getElementById('kick-all-devices-btn')!;
            return getComputedStyle(el).color;
        });
        expect(kickColor).toBe('rgb(255, 255, 255)');

        // The 2FA-disable button is hidden until 2FA is enabled, but its
        // computed color must already be white so it is never red-on-red.
        const disable2faColor = await page.evaluate(() => {
            const el = document.getElementById('disable-2fa-btn')!;
            return getComputedStyle(el).color;
        });
        expect(disable2faColor).toBe('rgb(255, 255, 255)');
    });

    test('DM call: a profile update refreshes the partner name/color in the tile WITHOUT rebuilding the video element', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'vsagp1_' + ts;
        const user2 = 'vsagp2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, user2);

        // A turns the camera on so there is a real <video> tile on B.
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page2.waitForSelector('.dm-call-tile video[data-kind="camera"]', { state: 'visible', timeout: 20000 });

        const aUid = body1.user.id;
        // Give the video element a unique marker so identity is trackable.
        await page2.evaluate((uid) => {
            const v = document.querySelector('.dm-call-tile video[data-kind="camera"][data-uid="' + uid + '"]');
            if (v) v.setAttribute('data-test-marker', 'keepme-' + uid);
        }, aUid);

        // Simulate a decrypted profile update landing on B (the same cache
        // write chat.js performs in the profile_updated handler), then the
        // VoiceManager hook chat.js calls right after.
        const newName = 'Renamed_' + ts;
        await page2.evaluate(({ uid, newName }) => {
            if (!(window as any).userDisplayNameCache) (window as any).userDisplayNameCache = {};
            (window as any).userDisplayNameCache[uid] = Object.assign({}, (window as any).userDisplayNameCache[uid] || {}, {
                display_name: newName,
                username_color: '#ff8800',
            });
            (window as any).VoiceManager.refreshMemberProfile(uid);
        }, { uid: aUid, newName });

        // The tile name (first non-badge node in .dm-call-tile-info) updates.
        await page2.waitForFunction(({ uid, newName }) => {
            const tile = document.querySelector('.dm-call-tile[data-uid="' + uid + '"]');
            if (!tile) return false;
            const info = tile.querySelector('.dm-call-tile-info');
            if (!info) return false;
            let node = info.firstChild;
            while (node && node.nodeType === 3 && !node.nodeValue.trim()) node = node.nextSibling;
            return node && node.textContent === newName;
        }, { uid: aUid, newName }, { timeout: 10000 });

        // The name keeps its color styling.
        const nameInfo = await page2.evaluate((uid) => {
            const tile = document.querySelector('.dm-call-tile[data-uid="' + uid + '"]');
            const info = tile!.querySelector('.dm-call-tile-info')!;
            let node = info.firstChild;
            while (node && node.nodeType === 3 && !node.nodeValue.trim()) node = node.nextSibling;
            return { text: node ? node.textContent : null, color: (node as HTMLElement).style ? (node as HTMLElement).style.color : '' };
        }, aUid);
        expect(nameInfo.text).toBe(newName);
        expect(nameInfo.color).toBe('rgb(255, 136, 0)');

        // The video element was NOT rebuilt (same marker survives).
        const after = await page2.evaluate((uid) => {
            const v = document.querySelector('.dm-call-tile video[data-kind="camera"][data-uid="' + uid + '"]');
            return v ? v.getAttribute('data-test-marker') : null;
        }, aUid);
        expect(after).toBe('keepme-' + aUid);
        await ctx2.close();
    });
});
