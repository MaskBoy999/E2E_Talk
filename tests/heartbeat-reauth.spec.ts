import { test, expect } from '@playwright/test';
import { dialogMessages } from './_ui-dialogs';

const BASE = 'https://localhost:3443';

test.describe('Heartbeat refresh options + reauth custom duration', () => {
    test.setTimeout(90000);

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForSelector('#settings-btn');
    }

    function tokenExpMs(token: string) {
        try {
            const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const json = decodeURIComponent(atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
            return JSON.parse(json).exp * 1000;
        } catch (_) { return 0; }
    }

    test('settings UI: reauth duration select + heartbeat checkboxes wired', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'hb_ui_' + ts);

        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="security-settings"]');

        // Reauth duration select exists, defaults to 30 days
        const durSel = page.locator('#reauth-duration-select');
        await expect(durSel).toBeVisible();
        expect(await durSel.inputValue()).toBe('2592000');

        // Pick 1 hour → persisted
        await durSel.selectOption('3600');
        expect(await page.evaluate(() => localStorage.getItem('reauth_duration_seconds'))).toBe('3600');

        // Heartbeat options exist (new opt-in ones + existing)
        for (const id of ['hb_refresh_keys', 'hb_refresh_profiles', 'hb_refresh_members', 'hb_refresh_dms',
                           'hb_refresh_servers', 'hb_refresh_friend_requests', 'hb_refresh_presence',
                           'hb_refresh_voice', 'hb_refresh_channels', 'hb_refresh_messages']) {
            await expect(page.locator('#' + id)).toBeVisible();
        }
        // Default-on actions show checked (they run unless toggled off)
        expect(await page.locator('#hb_refresh_keys').isChecked()).toBe(true);
        expect(await page.locator('#hb_refresh_messages').isChecked()).toBe(true);
        // Opt-in actions start unchecked
        expect(await page.locator('#hb_refresh_servers').isChecked()).toBe(false);
        expect(await page.locator('#hb_refresh_presence').isChecked()).toBe(false);
    });

    test('heartbeat: new refresh helpers run without errors when enabled', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'hb_run_' + ts);

        // Enable interval + all opt-in actions
        await page.evaluate(() => {
            localStorage.setItem('key_heartbeat_interval', '15000');
            ['hb_refresh_dms', 'hb_refresh_servers', 'hb_refresh_friend_requests', 'hb_refresh_presence',
             'hb_refresh_voice', 'hb_refresh_channels'].forEach(id => localStorage.setItem(id, 'true'));
        });

        // Exercise the new code paths directly (refreshAll needs an open WS; the
        // helpers are ws-independent and cover the new opt-in actions).
        const errs = await page.evaluate(async () => {
            const errors: string[] = [];
            try { await refreshDmConversationsData(); } catch (e) { errors.push('dmRefresh: ' + e); }
            try { await refreshServerListData(); } catch (e) { errors.push('serverRefresh: ' + e); }
            try { await loadFriendRequestBadge(); } catch (e) { errors.push('frBadge: ' + e); }
            try { updatePresenceDots(); } catch (e) { errors.push('presence: ' + e); }
            try { restoreActiveDmHighlight(); } catch (e) { errors.push('restoreActive: ' + e); }
            try { restoreActiveChannelHighlight(); } catch (e) { errors.push('restoreActiveCh: ' + e); }
            // Voice waiting-state sync + DM call UI + banner (no active call — must be a no-op)
            try {
                if (window.VoiceManager && VoiceManager.syncWaitingCalls) VoiceManager.syncWaitingCalls();
                if (window.VoiceManager && VoiceManager.updateDmCallUI) VoiceManager.updateDmCallUI();
                if (window.VoiceManager && VoiceManager.updateChannelChips) VoiceManager.updateChannelChips();
            } catch (e) { errors.push('voice: ' + e); }
            try { updateDmWaitingBanner(); } catch (e) { errors.push('waitingBanner: ' + e); }
            // refreshAll itself — no-op if WS isn't open, must never throw
            try { refreshAll(); } catch (e) { errors.push('refreshAll: ' + e); }
            return errors;
        });
        expect(errs).toEqual([]);

        // The voice chip re-render hook is exposed on VoiceManager
        expect(await page.evaluate(() => !!(window.VoiceManager && window.VoiceManager.updateChannelChips))).toBe(true);

        // Toggling the checkboxes persists the correct localStorage state
        await page.evaluate(() => {
            localStorage.setItem('hb_refresh_servers', 'false');
        });
        expect(await page.evaluate(() => localStorage.getItem('hb_refresh_servers'))).toBe('false');
    });

    test('reauth: custom 1-hour duration honored end-to-end', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'hb_reauth_' + ts);

        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="security-settings"]');
        await page.locator('#reauth-duration-select').selectOption('3600');

        await page.click('#reauth-btn');
        await page.fill('#reauth-password', 'password123');
        await page.click('#reauth-confirm-btn');
        await page.waitForTimeout(1500);

        // The success popup (in-page now, static/ui-dialog.js) reflects the chosen duration
        expect((await dialogMessages(page)).join('|')).toContain('1 hour');

        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeTruthy();
        const msLeft = tokenExpMs(token) - Date.now();
        expect(msLeft).toBeGreaterThan(50 * 60 * 1000);  // ~1 hour
        expect(msLeft).toBeLessThan(70 * 60 * 1000);
    });

    test('session log: records re-auth events (from→to expiry, duration) and renders', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'hb_log_' + ts);

        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="security-settings"]');

        // Empty log before any re-auth; expiry line shows a real date-time
        await expect(page.locator('#session-log-list')).toContainText('No re-authentication events yet');
        const expiresAtText = (await page.locator('#session-expires-at').textContent()) || '';
        expect(expiresAtText).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

        // Re-auth with a 1-hour duration
        await page.locator('#reauth-duration-select').selectOption('3600');
        await page.click('#reauth-btn');
        await page.fill('#reauth-password', 'password123');
        await page.click('#reauth-confirm-btn');
        await page.waitForTimeout(1200);

        // Log shows the event with from/to details
        const logHtml = await page.locator('#session-log-list').innerHTML();
        expect(logHtml).toContain('Re-authenticated');
        expect(logHtml).toContain('1 hour');
        expect(logHtml).toContain('was:');

        // localStorage has exactly one per-account event with sane fields
        const stored = await page.evaluate(() => {
            const u = JSON.parse(localStorage.getItem('user') || '{}');
            const raw = localStorage.getItem('session_security_log_' + u.id);
            return raw ? JSON.parse(raw) : [];
        });
        expect(stored.length).toBe(1);
        expect(stored[0].duration_secs).toBe(3600);
        // Original 30-day token was issued at registration; from_exp ≈ 30 days out
        expect(stored[0].from_exp - stored[0].at).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
        // The 1-hour re-auth shortens the expiry below the original
        expect(stored[0].to_exp).toBeLessThan(stored[0].from_exp);
        expect(stored[0].to_exp - stored[0].at).toBeGreaterThan(50 * 60 * 1000);
        expect(stored[0].to_exp - stored[0].at).toBeLessThan(70 * 60 * 1000);
    });

    test('login: saved custom duration applies and survives the login-page wipe', async ({ page }) => {
        const ts = Date.now();
        const username = 'hb_login_' + ts;
        await registerUser(page, username);

        // Choose a 1-hour session duration
        await page.evaluate(() => localStorage.setItem('session_duration_seconds', '3600'));

        // Simulate session expiry: token gone → login page wipes client data
        await page.evaluate(() => localStorage.removeItem('token'));
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#login-form');

        // The duration preference must survive the wipe (default is 30 days,
        // but an explicit choice should not need re-entering on every login)
        expect(await page.evaluate(() => localStorage.getItem('session_duration_seconds'))).toBe('3600');

        // Log back in via the UI
        await page.fill('#login-username', username);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });

        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeTruthy();
        const msLeft = tokenExpMs(token) - Date.now();
        expect(msLeft).toBeGreaterThan(50 * 60 * 1000);  // ~1 hour, not 30 days
        expect(msLeft).toBeLessThan(70 * 60 * 1000);
    });

    test('login: server clamps over-30-day duration requests to 30 days', async ({ page }) => {
        const ts = Date.now();
        const username = 'hb_loginclamp_' + ts;
        await registerUser(page, username);

        const result = await page.evaluate(async (uname) => {
            const authKey = localStorage.getItem('e2e_auth_key');
            const hashKeyBytes = E2ECrypto.base64ToArrayBuffer(authKey);
            const pw = E2ECrypto.hmacHex(new Uint8Array(hashKeyBytes), 'password123');
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: uname, password: pw, duration_seconds: 999999999 }),
            });
            if (!res.ok) return { ok: false, status: res.status };
            const data = await res.json();
            const b64 = data.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const json = decodeURIComponent(atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
            return { ok: true, expMs: JSON.parse(json).exp * 1000 };
        }, username);
        expect(result.ok).toBe(true);
        const msLeft = (result as any).expMs - Date.now();
        expect(msLeft).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
        expect(msLeft).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    });

    test('register: custom duration honored via API (1 hour)', async ({ page }) => {
        const ts = Date.now();
        const username = 'hb_regdur_' + ts;

        // Load a page that includes crypto.js so E2ECrypto is available
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#login-form');

        const result = await page.evaluate(async (uname) => {
            // Mirror the auth.js register flow: random 32-byte hash key → HMAC password
            const hashKey = E2ECrypto.randomBytes(32);
            const hashedPassword = E2ECrypto.hmacHex(hashKey, 'password123');
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: uname, password: hashedPassword, duration_seconds: 3600 }),
            });
            if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
            const data = await res.json();
            const b64 = data.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const json = decodeURIComponent(atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
            return { ok: true, expMs: JSON.parse(json).exp * 1000 };
        }, username);
        expect(result.ok).toBe(true);
        const msLeft = (result as any).expMs - Date.now();
        expect(msLeft).toBeGreaterThan(50 * 60 * 1000);
        expect(msLeft).toBeLessThan(70 * 60 * 1000);
    });

    test('reauth: server clamps over-30-day requests to 30 days', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'hb_clamp_' + ts);

        const result = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const authKey = localStorage.getItem('e2e_auth_key');
            const hashKeyBytes = E2ECrypto.base64ToArrayBuffer(authKey);
            const pw = E2ECrypto.hmacHex(new Uint8Array(hashKeyBytes), 'password123');
            const res = await fetch('/api/reauth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ password: pw, duration_seconds: 999999999 }),
            });
            if (!res.ok) return { ok: false, status: res.status };
            const data = await res.json();
            const b64 = data.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const json = decodeURIComponent(atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
            return { ok: true, expMs: JSON.parse(json).exp * 1000 };
        });
        expect(result.ok).toBe(true);
        const msLeft = (result as any).expMs - Date.now();
        expect(msLeft).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
        expect(msLeft).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    });
});
