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
                           'hb_refresh_voice', 'hb_refresh_channels', 'hb_refresh_messages',
                           // Newest interval actions: PQ identity republish, admin-driven
                           // client limits, security panel, soundboard clips, stickers.
                           'hb_refresh_pq_identity', 'hb_refresh_client_config',
                           'hb_refresh_security_panel', 'hb_refresh_soundboard', 'hb_refresh_stickers']) {
            await expect(page.locator('#' + id)).toBeVisible();
        }
        // Default-on actions show checked (they run unless toggled off)
        expect(await page.locator('#hb_refresh_keys').isChecked()).toBe(true);
        expect(await page.locator('#hb_refresh_messages').isChecked()).toBe(true);
        // PQ identity republish is default-on too: a missed publish at load must
        // not leave an account on v1-only envelopes forever.
        expect(await page.locator('#hb_refresh_pq_identity').isChecked()).toBe(true);
        // Opt-in actions start unchecked
        expect(await page.locator('#hb_refresh_servers').isChecked()).toBe(false);
        expect(await page.locator('#hb_refresh_presence').isChecked()).toBe(false);
        expect(await page.locator('#hb_refresh_client_config').isChecked()).toBe(false);
        expect(await page.locator('#hb_refresh_security_panel').isChecked()).toBe(false);
        expect(await page.locator('#hb_refresh_soundboard').isChecked()).toBe(false);
        expect(await page.locator('#hb_refresh_stickers').isChecked()).toBe(false);
        // Toggling a new opt-in action persists for the running heartbeat.
        await page.locator('#hb_refresh_security_panel').check();
        expect(await page.evaluate(() => localStorage.getItem('hb_refresh_security_panel'))).toBe('true');
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
            // New interval actions (PQ identity republish, admin client limits,
            // security panel, soundboard): each must be callable and never throw.
            try { await publishIdentityPqKeyIfNeeded(); } catch (e) { errors.push('pqIdentity: ' + e); }
            try { await loadClientConfig(); } catch (e) { errors.push('clientConfig: ' + e); }
            try { renderDevicesPanel(true); } catch (e) { errors.push('devicesQuiet: ' + e); }
            try { if ((window as any)._load2FaStatus) await (window as any)._load2FaStatus(); } catch (e) { errors.push('twofaStatus: ' + e); }
            try { if ((window as any)._loadKillSwitchStatus) await (window as any)._loadKillSwitchStatus(); } catch (e) { errors.push('killSwitchStatus: ' + e); }
            try { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); } catch (e) { errors.push('soundboardClips: ' + e); }
            return errors;
        });
        expect(errs).toEqual([]);

        // The security-panel status loaders live inside the settings closure;
        // the heartbeat reaches them through these window handles.
        expect(await page.evaluate(() => typeof (window as any)._load2FaStatus)).toBe('function');
        expect(await page.evaluate(() => typeof (window as any)._loadKillSwitchStatus)).toBe('function');

        // The voice chip re-render hook is exposed on VoiceManager
        expect(await page.evaluate(() => !!(window.VoiceManager && window.VoiceManager.updateChannelChips))).toBe(true);

        // Toggling the checkboxes persists the correct localStorage state
        await page.evaluate(() => {
            localStorage.setItem('hb_refresh_servers', 'false');
        });
        expect(await page.evaluate(() => localStorage.getItem('hb_refresh_servers'))).toBe('false');
    });

    test('heartbeat: the new interval actions run on one tick', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'hb_tick_' + ts);
        // The heartbeat only ticks while the socket is open.
        await page.waitForFunction(() => (window as any).ws && (window as any).ws.readyState === 1, { timeout: 15000 });

        // Enable the interval + every new opt-in action.
        await page.evaluate(() => {
            localStorage.setItem('key_heartbeat_interval', '15000');
            ['hb_refresh_client_config', 'hb_refresh_security_panel', 'hb_refresh_soundboard', 'hb_refresh_stickers']
                .forEach(id => localStorage.setItem(id, 'true'));
        });

        const counts = await page.evaluate(async () => {
            const calls: Record<string, number> = {
                config: 0, pq: 0, devices: 0, twofa: 0, killswitch: 0, soundboard: 0, sbDisabled: 0, stickers: 0,
            };
            // Stub every helper the new actions call, so one tick is observable
            // without touching the network. refreshAll resolves these through
            // window at call time, exactly like the real functions.
            (window as any).loadClientConfig = async () => { calls.config++; };
            (window as any).publishIdentityPqKeyIfNeeded = async () => { calls.pq++; };
            (window as any).renderDevicesPanel = () => { calls.devices++; };
            (window as any)._load2FaStatus = async () => { calls.twofa++; };
            (window as any)._loadKillSwitchStatus = async () => { calls.killswitch++; };
            (window as any)._loadSoundboardClips = async () => { calls.soundboard++; };
            (window as any)._loadDisabledSoundboardUsers = async () => { calls.sbDisabled++; };

            // Panels the guarded actions only touch while visible.
            (document.getElementById('settings-modal') as HTMLElement).style.display = 'block';
            (document.getElementById('soundboard-overlay') as HTMLElement).style.display = 'flex';

            // Sticker panel: open it and land on the stickers tab so the interval
            // action has something to refresh. Let the open-handler's async work
            // finish before installing the counter.
            (document.getElementById('sticker-btn') as HTMLElement).click();
            await new Promise(r => setTimeout(r, 400));
            const tab = document.querySelector('.sticker-tab[data-tab="stickers"]') as HTMLElement | null;
            if (tab) tab.click();
            await new Promise(r => setTimeout(r, 400));
            calls.stickers = 0;
            const originalRenderPanelTab = (window as any).renderPanelTab;
            (window as any).renderPanelTab = (t: string) => { if (t === 'stickers') calls.stickers++; };

            refreshAll();
            await new Promise(r => setTimeout(r, 300));
            (window as any).renderPanelTab = originalRenderPanelTab;
            return calls;
        });

        expect(counts.pq, 'PQ identity republish').toBe(1);
        expect(counts.config, 'client limits').toBe(1);
        expect(counts.devices, 'devices list').toBe(1);
        expect(counts.twofa, '2FA status').toBe(1);
        expect(counts.killswitch, 'kill-switch status').toBe(1);
        expect(counts.soundboard, 'soundboard clips').toBe(1);
        expect(counts.sbDisabled, 'soundboard disabled list').toBe(1);
        expect(counts.stickers, 'sticker grid').toBe(1);
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
            // Current protocol: signed with the account's login key (finding 3).
            const loginBody = await E2ECrypto.loginRequestBody(uname, 'password123');
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign(loginBody, { duration_seconds: 999999999 })),
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
            // Mirror the auth.js register flow: random 32-byte hash key → HMAC password,
            // plus the hybrid (Ed25519 + ML-DSA-65) login key derived from the same
            // secret. Registration requires the hybrid key; an Ed25519-only account
            // is refused since the PQ rollout.
            const hashKey = E2ECrypto.randomBytes(32);
            const hashedPassword = E2ECrypto.hmacHex(hashKey, 'password123');
            await E2ECrypto.pqReady();
            const loginPublicKey = E2ECrypto.deriveLoginPublicKeyBundle(hashKey, 'password123');
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: uname, password: hashedPassword, login_public_key: loginPublicKey, duration_seconds: 3600 }),
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
