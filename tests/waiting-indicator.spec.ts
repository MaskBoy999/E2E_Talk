import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('DM-call waiting indicator: no dismiss, refresh persistence, leave/unfriend clears', () => {

    // Debug helper: prints the VoiceManager state at a checkpoint so a stuck
    // step shows exactly what was/is wrong instead of a bare timeout.
    async function dbg(page: any, label: string) {
        const st = await page.evaluate(() => {
            const v = window.VoiceManager as any;
            if (!v) return { loaded: false };
            const s = v._debug.state;
            return {
                loaded: true,
                dmCallActive: s.dmCallActive,
                callWaiting: s.callWaiting,
                answered: s.dmCallAnswered,
                connected: s.connected,
                room: s.roomType,
                members: Object.keys(s.members).length,
                waitingChannels: Object.keys(s.waitingCalls || {}),
            };
        });
        console.log('[DBG]', label, JSON.stringify(st));
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

    async function startCallAndDecline(page: any, page2: any, dm: any, userData: any, user2: string) {
        await waitForWs(page);
        await waitForWs(page2);
        // Shrink the 30s ring timeout so the timeout flows (if any) run fast.
        await page.evaluate(() => window.VoiceManager.setRingTimeoutMs(4000));
        await page2.evaluate(() => window.VoiceManager.setRingTimeoutMs(4000));
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 10000 });
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });
        // Callee receives the ring and declines → caller enters waiting.
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });
        await page2.evaluate(() => window.VoiceManager.declineDmCall());
        // Caller is waiting.
        await page.waitForFunction((dmId) => {
            const v = window.VoiceManager;
            return v && v.getCallState && v.getCallState(dmId) === 'waiting';
        }, dm.id, { timeout: 15000 });
        // Callee's persisted marker is set.
        await page2.waitForFunction((dmId) => {
            const v = window.VoiceManager;
            return v && v.getWaitingCall && !!v.getWaitingCall(dmId);
        }, dm.id, { timeout: 15000 });
    }

    test('waiting indicator: not dismissible; callee refresh keeps it, caller refresh closes the call', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1 = 'waitA_' + ts;
        const user2 = 'waitB_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await startCallAndDecline(page, page2, dm, userData, user2);

        // --- Not dismissible: no close button on the waiting banner ---
        await page2.click('#dm-strip-btn').catch(() => {});
        await page2.waitForTimeout(800);
        for (let i = 0; i < 40; i++) {
            const conv = page2.locator('.dm-item, .dm-conv, [data-dm-id]');
            if (await conv.count()) { await conv.first().click().catch(() => {}); await page2.waitForTimeout(800); break; }
            await page2.waitForTimeout(300);
        }
        await page2.waitForSelector('#dm-waiting-banner', { timeout: 10000 });
        await page2.waitForFunction(() => {
            const b = document.getElementById('dm-waiting-banner');
            return b && b.style.display !== 'none';
        }, undefined, { timeout: 10000 });
        const closeBtnCount = await page2.locator('#dm-waiting-close-btn').count();
        expect(closeBtnCount).toBe(0);

        // --- Caller's UI: waiting room active, mini-bar says "Waiting for" ---
        await dbg(page, 'caller after decline');
        const callerWaiting = await page.evaluate(() => {
            const v = window.VoiceManager as any;
            const s = v.getState();
            return { dmCallActive: s.dmCallActive, callWaiting: s.callWaiting };
        });
        expect(callerWaiting.dmCallActive).toBe(true);
        expect(callerWaiting.callWaiting).toBe(true);
        // The call UI is up: either the DM call panel (when the conversation is
        // open) or the mini-bar (when elsewhere) shows the waiting state.
        await page.waitForFunction(() => {
            const p = document.getElementById('dm-call-panel');
            const m = document.getElementById('dm-mini-bar');
            const v = document.getElementById('voice-bar');
            if (p && p.style.display !== 'none') {
                const n = document.getElementById('dm-call-name');
                return n && /Waiting for/i.test(n.textContent || '');
            }
            if (m && m.style.display !== 'none') {
                const n = document.getElementById('dm-mini-bar-name');
                return n && /Waiting for/i.test(n.textContent || '');
            }
            if (v && v.style.display !== 'none') return true; // any bar is enough
            return false;
        }, undefined, { timeout: 10000 });

        // --- Callee refreshes: sidebar dot appears WITHOUT opening the conversation ---
        await page2.reload();
        await page2.waitForSelector('.dm-item, [data-dm-id]', { timeout: 15000 });
        await page2.waitForFunction(() => {
            return !!document.querySelector('.dm-waiting-dot');
        }, undefined, { timeout: 15000 });

        // --- Caller refreshes: auto-rejoins the waiting room, call UI returns ---
        await dbg(page2, 'callee after refresh');
        // Caller refreshes → the call CLOSES: the caller is not in any room.
        await page.reload();
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && !v.isInDmCall() && !v.isConnected();
        }, undefined, { timeout: 15000 });
        await dbg(page, 'caller after refresh (call closed)');
        // Once the server grace window passes, the waiting marker is cleared
        // and the CALLEE's indicator disappears (dm_waiting_cleared) — no
        // conversation reload needed.
        await page2.waitForFunction((dmId) => {
            const v = window.VoiceManager;
            return v && v.getWaitingCall ? !v.getWaitingCall(dmId) : true;
        }, dm.id, { timeout: 25000 });
        await dbg(page2, 'callee after grace (indicator cleared)');
        await page2.waitForTimeout(800);
        const dotGone = await page2.evaluate(() => !!document.querySelector('.dm-waiting-dot'));
        expect(dotGone).toBe(false);
    });

    test('waiter explicitly leaving clears the callee indicator', async ({ page, context }) => {
        test.setTimeout(90000);
        const ts = Date.now();
        const user1 = 'leaveA_' + ts;
        const user2 = 'leaveB_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await startCallAndDecline(page, page2, dm, userData, user2);

        // Callee's marker exists.
        const hasMarker = await page2.evaluate((dmId) => {
            const v = window.VoiceManager as any;
            return !!(v.getWaitingCall && v.getWaitingCall(dmId));
        }, dm.id);
        expect(hasMarker).toBe(true);

        // Caller hangs up for good.
        await page.evaluate(() => window.VoiceManager.endDmCall());

        // Callee's waiting marker must clear (dm_call_end → no active call path).
        await page2.waitForFunction((dmId) => {
            const v = window.VoiceManager;
            return v && v.getWaitingCall ? !v.getWaitingCall(dmId) : true;
        }, dm.id, { timeout: 15000 });

        // Server row is gone too.
        const convs = await (await page2.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        const conv = convs.find((c: any) => c.dm_channel_id === dm.id);
        expect(conv && conv.waiting_user_id).toBeFalsy();

        // Sidebar dot is gone after a sidebar re-render.
        const dotGone = await page2.evaluate(() => !!document.querySelector('.dm-waiting-dot'));
        expect(dotGone).toBe(false);
    });

    test('unfriend ends an ACTIVE DM call on both sides', async ({ page, context }) => {
        test.setTimeout(90000);
        const ts = Date.now();
        const user1 = 'unfA_' + ts;
        const user2 = 'unfB_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);

        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });
        await page2.evaluate(() => window.VoiceManager.acceptDmCall());
        // Both connected.
        await page.waitForFunction((dmId) => {
            const v = window.VoiceManager;
            return v && v.getCallState && v.getCallState(dmId) === 'connected';
        }, dm.id, { timeout: 20000 });
        await page2.waitForFunction((dmId) => {
            const v = window.VoiceManager;
            return v && v.getCallState && v.getCallState(dmId) === 'connected';
        }, dm.id, { timeout: 20000 });

        // A unfriends B.
        const rem = await page.request.post(`${BASE}/api/friends/remove`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { user_id: userData.id },
        });
        expect(rem.ok()).toBeTruthy();

        // Both clients tear the call down.
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.getState().dmCallActive === false;
        }, undefined, { timeout: 15000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.getState().dmCallActive === false;
        }, undefined, { timeout: 15000 });
        // No waiting marker anywhere.
        const markers = await page.evaluate(() => {
            const v = window.VoiceManager as any;
            return Object.keys(v.getState().waitingCalls || {}).length;
        });
        expect(markers).toBe(0);
        const markers2 = await page2.evaluate(() => {
            const v = window.VoiceManager as any;
            return Object.keys(v.getState().waitingCalls || {}).length;
        });
        expect(markers2).toBe(0);
    });

    test('unfriend while WAITING clears the room + indicator on both sides', async ({ page, context }) => {
        test.setTimeout(90000);
        const ts = Date.now();
        const user1 = 'unwA_' + ts;
        const user2 = 'unwB_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await startCallAndDecline(page, page2, dm, userData, user2);

        // A (the waiter) unfriends B.
        const rem = await page.request.post(`${BASE}/api/friends/remove`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { user_id: userData.id },
        });
        expect(rem.ok()).toBeTruthy();

        // A tears down.
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.getState().dmCallActive === false;
        }, undefined, { timeout: 15000 });
        // B's indicator clears (server row cleared + dm_call_end).
        await page2.waitForFunction((dmId) => {
            const v = window.VoiceManager;
            return v && v.getWaitingCall ? !v.getWaitingCall(dmId) : true;
        }, dm.id, { timeout: 15000 });

        // Server row is gone.
        const convs = await (await page2.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        const conv = convs.find((c: any) => c.dm_channel_id === dm.id);
        expect(conv).toBeFalsy(); // the DM itself is gone after unfriend
    });
});
