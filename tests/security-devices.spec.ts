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
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function loginUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#login-username');
    await page.fill('#login-username', username);
    await page.fill('#login-password', 'password123');
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
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

// Open the settings modal, switch to the Security tab, and wait for the
// Devices list to render `n` rows.
async function openDevices(page: any, n: number) {
    await page.click('#settings-btn');
    await page.click('.settings-tab[data-tab="security-settings"]');
    await page.waitForSelector('#devices-list .device-item', { timeout: 10000 });
    await page.waitForFunction((count) => {
        const items = document.querySelectorAll('#devices-list .device-item');
        return items.length >= count;
    }, n, { timeout: 10000 });
}

test('list + force-kick one device from the Security > Devices panel', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u = 'dev_' + Date.now();
    await registerUser(page1, u);
    const kickedBody = await loginUser(page2, u);
    const kickedToken = kickedBody.token;
    await waitForWs(page1);
    await waitForWs(page2);

    // Device 1's panel shows both sessions; exactly one is "This device".
    await openDevices(page1, 2);
    const summary = await page1.evaluate(() => {
        const items = Array.from(document.querySelectorAll('#devices-list .device-item'));
        return {
            total: items.length,
            thisDevice: items.filter((el) => el.textContent!.includes('This device')).length,
            kickBtns: items.filter((el) => el.querySelector('.device-kick-btn')).length,
            names: items.map((el) => el.textContent!.slice(0, 60)),
        };
    });
    expect(summary.total).toBe(2);
    expect(summary.thisDevice).toBe(1);
    expect(summary.kickBtns).toBe(1); // only the OTHER device can be kicked

    // The listed device names come from the browser UA (sent at login).
    const nameText = summary.names.join(' ');
    expect(nameText.length).toBeGreaterThan(0);

    // Force-kick device 2 from device 1's panel — the styled, password-gated
    // confirm modal now opens (NOT a native dialog).
    await page1.click('#devices-list .device-kick-btn');
    await page1.waitForSelector('#kick-all-confirm-modal', { state: 'visible', timeout: 5000 });
    const modalTitle = await page1.evaluate(() => document.getElementById('kick-all-confirm-title')!.textContent || '');
    expect(modalTitle).toContain('Sign out this device?');

    // Wrong password: inline error, modal stays open, device 2 untouched.
    await page1.fill('#kick-all-password', 'wrongpass');
    await page1.click('#kick-all-confirm-yes');
    await page1.waitForSelector('#kick-all-error', { state: 'visible', timeout: 5000 });
    const errText = await page1.evaluate(() => document.getElementById('kick-all-error')!.textContent || '');
    expect(errText).toContain('Wrong password');
    let stillAlive = await ctx2.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + kickedToken },
    });
    expect(stillAlive.status()).toBe(200); // spamming the kick didn't work

    // Correct password: device 2 is signed out everywhere.
    await page1.fill('#kick-all-password', 'password123');
    await page1.click('#kick-all-confirm-yes');
    await page1.waitForSelector('#kick-all-confirm-modal', { state: 'hidden', timeout: 5000 });

    // Device 2 is signed out everywhere: WS session_revoked → login page.
    await page2.waitForURL('**/login.html', { timeout: 12000 });

    // Device 2's old token is now rejected by the API.
    const dead = await ctx2.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + kickedToken },
    });
    expect(dead.status()).toBe(401);
    // Device 1's own session still works.
    const alive = await page1.evaluate(() => fetch('/api/auth/sessions', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }).then((r) => r.status));
    expect(alive).toBe(200);

    // Device 1's panel no longer lists the kicked device at all — signed-out
    // sessions disappear from "signed in devices" instead of piling up as
    // "Signed out" entries. Only this device remains.
    await page1.waitForFunction(() => {
        const items = Array.from(document.querySelectorAll('#devices-list .device-item'));
        return items.length === 1 && items[0].textContent!.includes('This device');
    }, undefined, { timeout: 8000 });

    await ctx1.close();
    await ctx2.close();
});

test('kick-all signs out every other device and their tokens die', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u = 'dev2_' + Date.now();
    await registerUser(page1, u);
    const other = await loginUser(page2, u);
    await waitForWs(page1);
    await waitForWs(page2);

    // Capture device 2's token BEFORE the kick (it gets cleared client-side).
    const otherToken = other.token;

    // Device 1 signs out all other devices (API directly) — password-gated now.
    const kickAll = await page1.evaluate(async () => {
        const authKeyB64 = localStorage.getItem('e2e_auth_key');
        const key = new Uint8Array(E2ECrypto.base64ToArrayBuffer(authKeyB64));
        const current_password = E2ECrypto.hmacHex(key, 'password123');
        return fetch('/api/auth/sessions/kick-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ current_password }),
        }).then((r) => r.json());
    });
    expect(kickAll.ok).toBe(true);

    // Device 2 is redirected to login.
    await page2.waitForURL('**/login.html', { timeout: 12000 });

    // Device 2's old token is rejected on the API (session revoked).
    const status = await ctx2.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + otherToken },
    });
    expect(status.status()).toBe(401);

    // Device 1's own session still works.
    const alive = await page1.evaluate(() => fetch('/api/auth/sessions', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }).then((r) => r.status));
    expect(alive).toBe(200);

    await ctx1.close();
    await ctx2.close();
});

test('kick-all confirmation modal: cancel aborts, confirm signs out all other devices', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u = 'dev2ui_' + Date.now();
    await registerUser(page1, u);
    const other = await loginUser(page2, u);
    await waitForWs(page1);
    await waitForWs(page2);
    const otherToken = other.token;

    // Device 1 opens Settings → Security → Devices.
    await openDevices(page1, 2);

    // Clicking the button shows the confirmation modal (not a native dialog).
    await page1.click('#kick-all-devices-btn');
    await page1.waitForSelector('#kick-all-confirm-modal', { state: 'visible', timeout: 5000 });

    // Cancel: modal closes, nothing happens — device 2's token still works.
    await page1.click('#kick-all-confirm-cancel');
    await page1.waitForSelector('#kick-all-confirm-modal', { state: 'hidden', timeout: 5000 });
    let status = await ctx2.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + otherToken },
    });
    expect(status.status()).toBe(200);

    // Wrong password → inline error, modal stays open, nothing is signed out.
    await page1.click('#kick-all-devices-btn');
    await page1.waitForSelector('#kick-all-confirm-modal', { state: 'visible', timeout: 5000 });
    await page1.fill('#kick-all-password', 'wrongpass');
    await page1.click('#kick-all-confirm-yes');
    await page1.waitForSelector('#kick-all-error', { state: 'visible', timeout: 5000 });
    const errText = await page1.evaluate(() => document.getElementById('kick-all-error')!.textContent || '');
    expect(errText).toContain('Wrong password');
    status = await ctx2.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + otherToken },
    });
    expect(status.status()).toBe(200); // device 2 still signed in

    // Correct password: modal closes and every other device is signed out.
    await page1.fill('#kick-all-password', 'password123');
    await page1.click('#kick-all-confirm-yes');
    await page1.waitForSelector('#kick-all-confirm-modal', { state: 'hidden', timeout: 5000 });

    // Device 2 is redirected to login and its token is dead.
    await page2.waitForURL('**/login.html', { timeout: 12000 });
    status = await ctx2.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + otherToken },
    });
    expect(status.status()).toBe(401);

    // Device 1's own session still works.
    const alive = await page1.evaluate(() => fetch('/api/auth/sessions', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }).then((r) => r.status));
    expect(alive).toBe(200);

    await ctx1.close();
    await ctx2.close();
});

test('logout revokes the server-side session (token cannot be replayed)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const u = 'dev3_' + Date.now();
    const body = await registerUser(page, u);
    await waitForWs(page);

    // Log out — the client calls POST /api/logout.
    await page.evaluate(() => fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }));

    // The same token now 401s on any authenticated endpoint.
    const status = await ctx.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + body.token },
    });
    expect(status.status()).toBe(401);

    // The session is gone from the server's list (fresh login lists only itself).
    const body2 = await loginUser(page, u);
    const list = await ctx.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + body2.token },
    });
    const data = await list.json();
    expect(Array.isArray(data.sessions)).toBe(true);
    // The signed-out session is NOT in the list — only the fresh, active one.
    expect(data.sessions.length).toBe(1);
    expect(data.sessions[0].revoked).toBe(false);
    expect(data.sessions[0].is_current).toBe(true);

    await ctx.close();
});

test('repeated sign-in/out does not accumulate signed-out devices in the panel', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const u = 'dev_cycle_' + Date.now();
    await registerUser(page, u);

    // Sign out and back in several times — each login mints a NEW server-side
    // session row, so without filtering the panel would fill up with stale
    // "Signed out" entries.
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }));
        await page.evaluate(() => { localStorage.removeItem('token'); localStorage.removeItem('user'); });
        await loginUser(page, u);
    }

    // The panel lists ONLY the current session.
    await openDevices(page, 1);
    const count = await page.evaluate(() => document.querySelectorAll('#devices-list .device-item').length);
    expect(count).toBe(1);
    const text = await page.evaluate(() => document.querySelector('#devices-list .device-item')!.textContent || '');
    expect(text).toContain('This device');

    // Same via the raw API: every returned row is active, none signed-out.
    const list = await page.evaluate(() => fetch('/api/auth/sessions', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }).then((r) => r.json()));
    expect(list.sessions.length).toBe(1);
    expect(list.sessions[0].revoked).toBe(false);
    expect(list.sessions[0].is_current).toBe(true);

    await ctx.close();
});

test('WS auth rejects a kicked session after a full page refresh', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u = 'dev4_' + Date.now();
    await registerUser(page1, u);
    const kicked = await loginUser(page2, u);
    await waitForWs(page2);

    // Kick device 2 by session id via the API.
    const sessions = await ctx1.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + (await page1.evaluate(() => localStorage.getItem('token'))) },
    });
    const sessData = await sessions.json();
    const target = sessData.sessions.find((s: any) => s.id !== sessData.sessions.find((x: any) => x.is_current).id);
    expect(target).toBeTruthy();

    // Per-device kick is password-gated now: a kick without the current
    // password is rejected, so a stolen session can't spam individual
    // sign-outs. Compute the client-side hash exactly like the UI does.
    const badKick = await ctx1.request.post(`${BASE}/api/auth/sessions/kick`, {
        headers: { Authorization: 'Bearer ' + (await page1.evaluate(() => localStorage.getItem('token'))) },
        data: { session_id: target.id },
    });
    expect(badKick.status()).toBe(422); // missing current_password
    const stillAlive = await ctx2.request.get(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: 'Bearer ' + kicked.token },
    });
    expect(stillAlive.status()).toBe(200);

    const current_password = await page1.evaluate(() => {
        const authKeyB64 = localStorage.getItem('e2e_auth_key');
        const key = new Uint8Array(E2ECrypto.base64ToArrayBuffer(authKeyB64));
        return E2ECrypto.hmacHex(key, 'password123');
    });
    const kick = await ctx1.request.post(`${BASE}/api/auth/sessions/kick`, {
        headers: { Authorization: 'Bearer ' + (await page1.evaluate(() => localStorage.getItem('token'))) },
        data: { session_id: target.id, current_password },
    });
    expect((await kick.json()).ok).toBe(true);

    // Device 2's page is signed out live.
    await page2.waitForURL('**/login.html', { timeout: 12000 });

    // Simulate the "refresh with a stale token" fallback: put the old token
    // back and reload — WS auth must reject it (auth_error → login page).
    // (goto hangs on the mid-load redirect, so navigate via evaluate.)
    await page2.evaluate((t) => {
        localStorage.setItem('token', t);
        localStorage.removeItem('user');
        window.location.href = '/index.html';
    }, kicked.token);
    await page2.waitForURL('**/login.html', { timeout: 20000 });

    await ctx1.close();
    await ctx2.close();
});
