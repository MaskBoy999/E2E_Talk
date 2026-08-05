import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('DM call flow: decline, waiting, indicators, persistence', () => {

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

    test('decline: caller enters waiting, callee sees indicator, persists after refresh', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'dcl1_' + ts;
        const user2 = 'dcl2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);

        await waitForWs(page);
        await waitForWs(page2);

        await openDm(page);

        // Caller starts the call
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });

        // Callee receives the ring
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });
        expect(await page2.locator('#incoming-call-bar').isVisible().catch(() => false)).toBeTruthy();

        // Caller should show "Calling..." state
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.getCallState && v.getCallState(v._debug.state.dmChannelId) === 'calling';
        }, undefined, { timeout: 10000 });

        // Callee declines
        await page2.evaluate(() => window.VoiceManager.declineDmCall());

        // Caller should enter waiting state
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            const s = v._debug.state;
            return s.callWaiting && s.dmCallActive;
        }, undefined, { timeout: 10000 });

        // Check DM panel name (user is in DM view, so panel shows, not mini bar)
        const callerPanelText = await page.evaluate(() => {
            const el = document.getElementById('dm-call-name');
            return el ? el.textContent : null;
        });
        expect(callerPanelText).toContain('Waiting for');

        // Callee's DM sidebar should show waiting indicator
        await page2.evaluate(() => {
            document.querySelector('#dm-strip-btn')?.click();
        });
        await page2.waitForTimeout(1000);

        for (let i = 0; i < 40; i++) {
            const conv = page2.locator('[data-dm-id]');
            if (await conv.count()) {
                await conv.first().click().catch(() => {});
                await page2.waitForTimeout(800);
                break;
            }
            await page2.waitForTimeout(300);
        }

        const hasIndicator = await page2.evaluate(() => {
            return !!document.querySelector('.dm-waiting-dot, .dm-calling-dot');
        });
        expect(hasIndicator).toBeTruthy();

        // Callee's waiting banner should be visible
        const bannerVisible = await page2.locator('#dm-waiting-banner').isVisible().catch(() => false);
        expect(bannerVisible).toBeTruthy();

        // --- Page refresh persistence ---
        await page2.reload();
        await page2.waitForURL('**/index.html', { timeout: 15000 });
        await waitForWs(page2);
        await page2.waitForTimeout(2000);

        await page2.evaluate(() => {
            document.querySelector('#dm-strip-btn')?.click();
        });
        await page2.waitForTimeout(1000);
        for (let i = 0; i < 40; i++) {
            const conv = page2.locator('[data-dm-id]');
            if (await conv.count()) {
                await conv.first().click().catch(() => {});
                await page2.waitForTimeout(800);
                break;
            }
            await page2.waitForTimeout(300);
        }

        const bannerAfterRefresh = await page2.locator('#dm-waiting-banner').isVisible().catch(() => false);
        expect(bannerAfterRefresh).toBeTruthy();

        const indicatorAfterRefresh = await page2.evaluate(() => {
            return !!document.querySelector('.dm-waiting-dot');
        });
        expect(indicatorAfterRefresh).toBeTruthy();

        // Caller refreshes — server removes caller from room
        await page.reload();
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await waitForWs(page);
        await page.waitForTimeout(2000);

        // Caller is disconnected after refresh
        const callerDisconnected = await page.evaluate(() => {
            const v = window.VoiceManager;
            return v && !v.isInDmCall() && !v.isConnected();
        });
        expect(callerDisconnected).toBeTruthy();

        // Callee still sees the waiting indicator in the sidebar (persisted in DB)
        await page2.evaluate(() => {
            document.querySelector('#dm-strip-btn')?.click();
        });
        await page2.waitForTimeout(1000);
        for (let i = 0; i < 40; i++) {
            const conv = page2.locator('[data-dm-id]');
            if (await conv.count()) {
                await conv.first().click().catch(() => {});
                await page2.waitForTimeout(800);
                break;
            }
            await page2.waitForTimeout(300);
        }
        const indicatorStillVisible = await page2.evaluate(() => {
            return !!document.querySelector('.dm-waiting-dot');
        });
        expect(indicatorStillVisible).toBeTruthy();

        // Callee sees the waiting banner (caller is waiting for callee to join)
        const calleeBannerVisible = await page2.locator('#dm-waiting-banner').isVisible().catch(() => false);
        expect(calleeBannerVisible).toBeTruthy();

        await ctx2.close();
    });

    test('decline via UI button: caller stays in waiting room, callee can join manually', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'dclu1_' + ts;
        const user2 = 'dclu2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);

        await waitForWs(page);
        await waitForWs(page2);

        await openDm(page);

        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });

        // Callee receives the ring and declines with the REAL button
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });
        await page2.locator('#incoming-call-decline').click();

        // Caller enters waiting state — the call is NOT torn down (still dmCallActive)
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            const s = v._debug.state;
            return s.callWaiting && s.dmCallActive;
        }, undefined, { timeout: 10000 });

        const callerStillActive = await page.evaluate(() => {
            const v = window.VoiceManager;
            return v.isInDmCall();
        });
        expect(callerStillActive).toBeTruthy();

        // Callee opens the DM and clicks the real "Join Call" banner button
        await page2.evaluate(() => {
            document.querySelector('#dm-strip-btn')?.click();
        });
        await page2.waitForTimeout(1000);
        for (let i = 0; i < 40; i++) {
            const conv = page2.locator('[data-dm-id]');
            if (await conv.count()) {
                await conv.first().click().catch(() => {});
                await page2.waitForTimeout(800);
                break;
            }
            await page2.waitForTimeout(300);
        }

        const joinBtnVisible = await page2.locator('#dm-waiting-join-btn').isVisible().catch(() => false);
        expect(joinBtnVisible).toBeTruthy();
        await page2.locator('#dm-waiting-join-btn').click();

        // Both sides connect after the manual join
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 15000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 15000 });

        await ctx2.close();
    });

    test('accept and end: both connect, caller ends, callee disconnects', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'dca1_' + ts;
        const user2 = 'dca2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);

        await waitForWs(page);
        await waitForWs(page2);

        await openDm(page);

        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });

        // Callee receives ring
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });

        // Callee accepts
        await page2.evaluate(() => window.VoiceManager.acceptDmCall());

        // Both connected
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 15000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 15000 });

        // Caller's DM panel shows the partner's name
        const callerText = await page.evaluate(() => {
            const el = document.getElementById('dm-call-name');
            const el2 = document.getElementById('dm-mini-bar-name');
            return (el && el.textContent) || (el2 && el2.textContent) || null;
        });
        expect(callerText).toContain(user2);

        // DM sidebar shows connected indicator
        await page.evaluate(() => {
            document.querySelector('#dm-strip-btn')?.click();
        });
        await page.waitForTimeout(500);
        const hasConnected = await page.evaluate(() => {
            return !!document.querySelector('.dm-connected-dot');
        });
        expect(hasConnected).toBeTruthy();

        // Caller ends the call — leaves the room. Callee enters waiting state.
        await page.evaluate(() => window.VoiceManager.endDmCall());

        // Caller should be disconnected
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && !v.isInDmCall() && !v.isConnected();
        }, undefined, { timeout: 10000 });

        // Callee should be in waiting state (still in a call, waiting for caller)
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isInDmCall() && v.isCallWaiting();
        }, undefined, { timeout: 10000 });

        await ctx2.close();
    });
});
