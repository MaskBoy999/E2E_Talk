import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const BASE = 'https://localhost:3443';

test.describe('Server restart clears stale DM-call waiting state', () => {
    test('restart removes phantom "waiting" indicators without a conversation reload', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'rsA_' + ts;
        const user2 = 'rsB_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();

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

        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        // Friends
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

        // DM
        const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(dm.id).toBeTruthy();

        await waitForWs(page);
        await waitForWs(page2);

        // A calls, B declines → A waiting, row persisted.
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
        await page2.evaluate(() => window.VoiceManager.declineDmCall());
        await page.waitForFunction((dmId) => {
            const v = window.VoiceManager;
            return v && v.getCallState && v.getCallState(dmId) === 'waiting';
        }, dm.id, { timeout: 15000 });
        // Confirm the row exists server-side.
        const convsBefore = await (await page2.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        const convBefore = convsBefore.find((c: any) => c.dm_channel_id === dm.id);
        expect(convBefore && convBefore.waiting_user_id).toBeTruthy();

        // --- Simulate a server restart: spawn a SECOND instance sharing the DB.
        // Its startup clears every dm_call_waiting row (the restart invariant).
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) {
            throw new Error('server binary not found at ' + bin);
        }
        const child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: '3444',
                HTTPS_PORT: '3445',
                FRIEND_REQUEST_IP_MAX: '100000',
                FRIEND_REQUEST_USER_MAX: '100000',
                LOGIN_IP_MAX: '100000',
                LOGIN_USER_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000',
                HMAC_KEY_IP_MAX: '100000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Wait until the second instance is listening on 3444 (startup cleanup done).
        let up = false;
        for (let i = 0; i < 50; i++) {
            try {
                const r = await page.request.get('http://localhost:3444/').catch(() => null);
                if (r) { up = true; break; }
            } catch (_) { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 300));
        }
        expect(up).toBeTruthy();
        // Give the startup cleanup a moment, then stop the second instance.
        await new Promise((r) => setTimeout(r, 1000));
        child.kill();

        // --- The row is gone: B's conversations (on the MAIN server) show no waiting.
        const convsAfter = await (await page2.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        const convAfter = convsAfter.find((c: any) => c.dm_channel_id === dm.id);
        expect(convAfter && convAfter.waiting_user_id).toBeFalsy();

        // B refreshes → no waiting indicator anywhere (no conversation reload
        // needed, and no phantom row to resurrect it).
        await page2.reload();
        await page2.waitForSelector('.dm-item, [data-dm-id]', { timeout: 15000 });
        await page2.waitForTimeout(1500);
        const dots = await page2.evaluate(() => document.querySelectorAll('.dm-waiting-dot, .dm-for-us-dot').length);
        expect(dots).toBe(0);
        const bannerHidden = await page2.evaluate(() => {
            const b = document.getElementById('dm-waiting-banner');
            return !b || b.style.display === 'none';
        });
        expect(bannerHidden).toBe(true);
    });
});
