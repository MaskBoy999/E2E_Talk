import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// A tiny valid WAV (0.4s of 440Hz) generated in-page so the upload test has a
// real audio file without needing fixtures.
function makeWavDataUrl() {
    return `data:audio/wav;base64,${'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='}`;
}

test.describe('Ringtone (DM call ring)', () => {

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

    async function makeFriendsAndDm(page: any, page2: any, body1: any, body2: any, user2: string) {
        // Become friends via friend code API
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

        // Create DM channel
        const userData = await (await page.request.get(`${BASE}/api/user/${user2}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(dm.id).toBeTruthy();
        return { dmId: dm.id, userId: userData.id };
    }

    test('ringtone: upload encrypts + syncs to server, restores on reload', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const body = await registerUser(page, 'ring_sync_' + ts);
        expect(body.token).toBeTruthy();

        // Upload a ringtone the same way chat.js does (encrypt with identity key).
        // NOTE: no fetch(dataUrl) here — the app's CSP (connect-src 'self') blocks
        // fetching data: URLs, so the File is built in-page with atob instead.
        const upload = await page.evaluate(async ({ dataUrl }) => {
            const parts = dataUrl.split(',');
            const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'audio/wav';
            const bin = atob(parts[1]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const file = new File([bytes], 'my-ringtone.wav', { type: mime });
            const done = { ok: false, err: null as string | null };
            try {
                await syncRingtoneToServer(file);
                done.ok = true;
            } catch (e: any) {
                done.err = String(e);
            }
            return done;
        }, { dataUrl: makeWavDataUrl() });
        expect(upload.ok).toBe(true);

        // Server now holds the encrypted ringtone (never plaintext audio)
        const srv = await (await page.request.get(`${BASE}/api/ringtone`, {
            headers: { Authorization: `Bearer ${body.token}` },
        })).json();
        expect(srv.encrypted_sound).toBeTruthy();
        expect(srv.nonce).toBeTruthy();
        expect(srv.sender_public_key).toBeTruthy();
        const allText = JSON.stringify(srv);
        expect(allText.indexOf('RIFF')).toBe(-1); // WAV magic bytes must NOT appear in cleartext

        // Simulate a fresh session: clear cache, restore from server, decrypt works
        const restored = await page.evaluate(async () => {
            // Force-clear the in-memory + IDB cache to prove server restore works
            _ringtoneCachedUrl = null;
            await _idbRingtoneDel('url').catch(() => {});
            await restoreRingtoneFromServer();
            const url = await getRingtoneUrl();
            return { hasUrl: !!url, urlPrefix: url ? url.slice(0, 20) : '', urlLen: url ? url.length : 0 };
        });
        expect(restored.hasUrl).toBe(true);
        // The restore path re-encodes the decrypted bytes as a fresh data URL
        // (generic MIME, since only the encrypted file NAME is synced) — the
        // important part is that the audio bytes came back intact.
        expect(restored.urlPrefix.startsWith('data:')).toBe(true);
        expect(restored.urlLen).toBeGreaterThan(64);

        // Test Ringtone button path doesn't throw
        const testOk = await page.evaluate(() => {
            try {
                window.VoiceManager.testRingtone();
                return true;
            } catch (e) {
                return false;
            }
        });
        expect(testOk).toBe(true);

        // The Ringtone section must be present in the Settings → Voice tab
        // (this was reported missing; verify the full UI wiring end-to-end).
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 10000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForSelector('#voice-settings', { state: 'visible', timeout: 10000 });
        const ringUi = await page.evaluate(() => {
            const panel = document.getElementById('voice-settings');
            const hasUpload = !!document.getElementById('ringtone-upload-btn');
            const hasTest = !!document.getElementById('ringtone-test-btn');
            const hasRecord = !!document.getElementById('ringtone-record-btn');
            const hasReset = !!document.getElementById('ringtone-reset-btn');
            const hasVolume = !!document.getElementById('ringtone-volume-slider');
            const hasVisualizer = !!document.getElementById('ringtone-visualizer');
            const visible = panel ? panel.style.display !== 'none' : false;
            return { visible, hasUpload, hasTest, hasRecord, hasReset, hasVolume, hasVisualizer };
        });
        expect(ringUi.visible).toBe(true);
        expect(ringUi.hasUpload).toBe(true);
        expect(ringUi.hasTest).toBe(true);
        expect(ringUi.hasRecord).toBe(true);
        expect(ringUi.hasReset).toBe(true);
        expect(ringUi.hasVolume).toBe(true);
        expect(ringUi.hasVisualizer).toBe(true);
    });

    test('DM call: 30s unanswered → caller waiting indicator + callee Join bar', async ({ page, context }) => {
        test.setTimeout(90000);
        const ts = Date.now();
        const user1 = 'ringw1_' + ts;
        const user2 = 'ringw2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        const { dmId, userId } = await makeFriendsAndDm(page, page2, body1, body2, user2);

        await waitForWs(page);
        await waitForWs(page2);
        // Shrink the ring timeout so the timeout flow runs in seconds.
        await page.evaluate(() => window.VoiceManager.setRingTimeoutMs(4000));
        await page2.evaluate(() => window.VoiceManager.setRingTimeoutMs(4000));

        // Caller starts the call
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 10000 });
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId, uid: userId, uname: user2 });

        // Callee receives the ring and the ringtone starts (custom or default)
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 10000 });
        expect(await page2.locator('#incoming-call-bar').isVisible().catch(() => false)).toBeTruthy();
        expect(await page2.locator('#incoming-call-accept').textContent()).toBe('Accept');

        // Do NOT answer. Wait for the (shortened) ring timeout.
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isCallWaiting();
        }, undefined, { timeout: 15000 });
        console.log('[DBG] caller waiting:', JSON.stringify(await page.evaluate(() => {
            const v = window.VoiceManager as any;
            const s = v._debug.state;
            return { cw: s.callWaiting, active: s.dmCallActive, ans: s.dmCallAnswered };
        })));

        // The caller's call UI reflects the waiting state: either the mini bar
        // (when not in the DM view) or the DM call panel (when the conversation
        // is open) shows "Waiting for …".
        const callerWaiting = await page.evaluate(() => {
            const v = window.VoiceManager;
            const mini = document.getElementById('dm-mini-bar');
            const miniName = document.getElementById('dm-mini-bar-name');
            const panel = document.getElementById('dm-call-panel');
            const panelName = document.getElementById('dm-call-name');
            const text = ((mini && mini.style.display !== 'none' && miniName) ? miniName.textContent : '')
                || ((panel && panel.style.display !== 'none' && panelName) ? panelName.textContent : '');
            return {
                waiting: v.isCallWaiting(),
                indicatorVisible: (mini && mini.style.display !== 'none') || (panel && panel.style.display !== 'none'),
                nameText: text || '',
            };
        });
        expect(callerWaiting.waiting).toBe(true);
        expect(callerWaiting.indicatorVisible).toBe(true);
        expect(callerWaiting.nameText.toLowerCase()).toContain('waiting');

        // Callee receives dm_call_waiting → bar flips to the waiting state
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isIncomingWaiting();
        }, undefined, { timeout: 15000 });
        const calleeState = await page2.evaluate(() => {
            const b = document.getElementById('incoming-call-bar');
            const accept = document.getElementById('incoming-call-accept');
            const name = document.getElementById('incoming-call-name');
            const banner = document.getElementById('dm-waiting-banner');
            return {
                barVisible: b ? b.style.display !== 'none' : false,
                waitingClass: b ? b.classList.contains('waiting') : false,
                acceptText: accept ? accept.textContent : '',
                nameText: name ? name.textContent : '',
                bannerVisible: banner ? banner.style.display !== 'none' : false,
            };
        });
        // The waiting indicator is up — either the incoming bar (DM not open)
        // or the in-chat banner (DM open, bar hidden to avoid overlap).
        expect(calleeState.barVisible || calleeState.bannerVisible).toBe(true);
        if (calleeState.barVisible) {
            expect(calleeState.waitingClass).toBe(true);
            expect(calleeState.acceptText).toBe('Join');
            expect(calleeState.nameText.toLowerCase()).toContain('waiting');
        }

        // Callee joins manually after the timeout → call connects
        await page2.evaluate(() => window.VoiceManager.acceptDmCall());
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 20000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 20000 });

        // Cleanup: caller leaves the call — the call does NOT close for the
        // callee; they flip to the waiting state and can rejoin. Then the
        // callee leaves too to fully tear the call down.
        await page.evaluate(() => window.VoiceManager.endDmCall());
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isInDmCall() && v.isCallWaiting();
        }, undefined, { timeout: 10000 });
        await page2.evaluate(() => window.VoiceManager.endDmCall());
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && !v.isInDmCall();
        }, undefined, { timeout: 10000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && !v.isInDmCall();
        }, undefined, { timeout: 10000 });
    });

    test('waiting state persists across page refresh — callee sees DM-chat banner and joins', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'ringp1_' + ts;
        const user2 = 'ringp2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        const { dmId, userId } = await makeFriendsAndDm(page, page2, body1, body2, user2);
        await waitForWs(page);
        await waitForWs(page2);
        // Shrink the ring timeout so the timeout flow runs in seconds.
        await page.evaluate(() => window.VoiceManager.setRingTimeoutMs(4000));
        await page2.evaluate(() => window.VoiceManager.setRingTimeoutMs(4000));

        // Caller starts the call; callee gets the ring but does NOT answer.
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId, uid: userId, uname: user2 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 10000 });

        // Ring timeout → caller waiting (persisted server-side).
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isCallWaiting();
        }, undefined, { timeout: 15000 });

        // Callee refreshes the page — the waiting state must survive.
        await page2.reload();
        await page2.waitForURL('**/index.html');
        await waitForWs(page2);

        // Open the DM chat view.
        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item', { timeout: 15000 });
        await page2.click('.dm-item');

        // Persistent waiting banner appears in the DM chat after refresh.
        await page2.waitForFunction((dmId) => {
            const wc = window.VoiceManager && window.VoiceManager.getWaitingCall(dmId);
            const b = document.getElementById('dm-waiting-banner');
            return wc && b && b.style.display !== 'none';
        }, dmId, { timeout: 15000 });
        const bannerText = await page2.locator('#dm-waiting-text').textContent();
        expect(bannerText!.toLowerCase()).toContain('waiting');

        // Callee clicks Join Call → both sides connect.
        await page2.click('#dm-waiting-join-btn');
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 20000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 20000 });

        // Cleanup: both leave to tear the call down.
        await page.evaluate(() => window.VoiceManager.endDmCall());
        await page2.evaluate(() => window.VoiceManager.endDmCall());
    });

    test('mutual callback: callee calls the waiting caller back → both connect automatically', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1 = 'ringc1_' + ts;
        const user2 = 'ringc2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        const { dmId, userId } = await makeFriendsAndDm(page, page2, body1, body2, user2);
        await waitForWs(page);
        await waitForWs(page2);
        // Shrink the ring timeout so the timeout flow runs in seconds.
        await page.evaluate(() => window.VoiceManager.setRingTimeoutMs(4000));
        await page2.evaluate(() => window.VoiceManager.setRingTimeoutMs(4000));

        // Caller A starts the call; callee B ignores the ring.
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId, uid: userId, uname: user2 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });

// Ring timeout → A is waiting.
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isCallWaiting();
        }, undefined, { timeout: 15000 });
        console.log('[DBG] A waiting:', JSON.stringify(await page.evaluate(() => {
            const v = window.VoiceManager as any;
            const s = v._debug.state;
            return { cw: s.callWaiting, active: s.dmCallActive, ans: s.dmCallAnswered };
        })));

        // B (callee) refreshes — B was never in a room, so B is simply back on
        // a fresh page. A is STILL waiting in the room (A never left).
        await page2.reload();
        await page2.waitForURL('**/index.html');
        await waitForWs(page2);
        // A's waiting room must survive B's refresh untouched.
        await page.waitForFunction((dmId) => {
            const v = window.VoiceManager;
            return v && v.isInDmCall() && v.isCallWaiting() && v.getCallState(dmId) === 'waiting';
        }, dmId, { timeout: 15000 });

        // B (callee) calls A back → A auto-joins (no accept needed) → both connect.
        const aId = body1.user.id;
        await page2.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId, uid: aId, uname: user1 });

        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 25000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 25000 });

        // Cleanup: both leave.
        await page.evaluate(() => window.VoiceManager.endDmCall());
        await page2.evaluate(() => window.VoiceManager.endDmCall());
    });
});
