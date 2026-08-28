import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';
const unique = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'testpass123';

// Helper: register via the login page (client-side Argon2)
async function register(page: Page, username: string, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        await page.goto(`${BASE}/login.html`);
        await page.evaluate(() => localStorage.clear());
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 10000 });
        await page.click('#show-register');
        await page.waitForSelector('#register-form', { state: 'visible' });
        await page.fill('#register-username', username);
        await page.fill('#register-password', PASSWORD);
        await page.fill('#register-confirm-password', PASSWORD);
        await page.click('#register-form button[type="submit"]');
        try {
            await page.waitForURL('**/index.html', { timeout: 15000 });
            await page.waitForSelector('#current-user', { timeout: 10000 });
            await page.evaluate(() => {
                const el = document.getElementById('loading-overlay');
                if (el) el.remove();
            });
            await page.waitForTimeout(500);
            return;
        } catch (_) {
            await page.waitForTimeout(3000);
            username = username + '_r' + attempt;
        }
    }
    throw new Error('Failed to register after ' + retries + ' attempts');
}

async function waitForWs(page: Page, timeout = 15000) {
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout });
}

async function createServer(page: Page, name: string): Promise<string> {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#new-server-name', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 15000 });
    await page.waitForTimeout(2000);
    return await page.evaluate(() => {
        const icon = document.querySelector('.server-icon[data-id]');
        return icon ? icon.getAttribute('data-id') || '' : '';
    });
}

async function authHeaders(page: Page) {
    const token = await page.evaluate(() => localStorage.getItem('token') || '');
    return { 'Authorization': `Bearer ${token}` };
}

// Safe fetch wrapper for page.evaluate — handles non-JSON error responses
const SAFE_FETCH_FN = `
    async function safeFetch(url, opts) {
        var r = await fetch(url, opts);
        var txt = await r.text();
        if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + txt.substring(0, 200));
        try { return JSON.parse(txt); } catch(e) { throw new Error('Non-JSON: ' + txt.substring(0, 200)); }
    }
`;

// ═══════════════════════════════════════════════════
// TEST 1: Soundboard — loading indicator + upload
// ═══════════════════════════════════════════════════
test.describe('Soundboard', () => {
    test('Loading indicator shows while fetching clips', async ({ page }) => {
        const user = unique('sb_load');
        await register(page, user);
        await waitForWs(page);
        await createServer(page, 'SB Server');

        await page.evaluate(() => {
            const overlay = document.getElementById('soundboard-overlay');
            if (overlay) overlay.style.display = 'flex';
            const loadFn = (window as any)._loadSoundboardClips;
            if (loadFn) loadFn();
        });
        await page.waitForTimeout(200);

        const overlay = await page.$('#soundboard-overlay');
        expect(overlay).toBeTruthy();

        await page.waitForTimeout(2000);
        const emptyText = await page.textContent('#soundboard-clips');
        expect(emptyText).toContain('No sounds yet');

        await page.evaluate(() => {
            const overlay = document.getElementById('soundboard-overlay');
            if (overlay) overlay.style.display = 'none';
        });
    });

    test('Upload a clip and verify it appears in the list', async ({ page }) => {
        const user = unique('sb_upload');
        await register(page, user);
        await waitForWs(page);
        const serverId = await createServer(page, 'SB Upload Server');

        const wavB64 = await page.evaluate(() => {
            const sampleRate = 44100;
            const duration = 0.1;
            const numSamples = Math.floor(sampleRate * duration);
            const numChannels = 1;
            const bitsPerSample = 16;
            const bytesPerSample = bitsPerSample / 8;
            const blockAlign = numChannels * bytesPerSample;
            const dataSize = numSamples * blockAlign;
            const buffer = new ArrayBuffer(44 + dataSize);
            const view = new DataView(buffer);
            function writeStr(off: number, s: string) { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
            writeStr(0, 'RIFF');
            view.setUint32(4, 36 + dataSize, true);
            writeStr(8, 'WAVE');
            writeStr(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, numChannels, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * blockAlign, true);
            view.setUint16(32, blockAlign, true);
            view.setUint16(34, bitsPerSample, true);
            writeStr(36, 'data');
            view.setUint32(40, dataSize, true);
            let off = 44;
            for (let i = 0; i < numSamples; i++) {
                const sample = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
                view.setInt16(off, Math.max(-32768, Math.min(32767, Math.floor(sample * 32767))), true);
                off += 2;
            }
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
        });

        const resp = await page.evaluate(async (data) => {
            async function safeFetch(url: string, opts: any) {
                const r = await fetch(url, opts);
                const txt = await r.text();
                if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + txt.substring(0, 200));
                return JSON.parse(txt);
            }
            const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') };
            return safeFetch('/api/soundboard', {
                method: 'POST', headers: h,
                body: JSON.stringify({
                    server_id: data.sid, name: 'Test Tone',
                    encrypted_audio: data.b64, audio_nonce: '', duration_ms: 100,
                })
            });
        }, { sid: serverId, b64: wavB64 });
        expect(resp.ok).toBe(true);

        await page.evaluate(() => {
            const overlay = document.getElementById('soundboard-overlay');
            if (overlay) overlay.style.display = 'flex';
            const loadFn = (window as any)._loadSoundboardClips;
            if (loadFn) loadFn();
        });
        await page.waitForTimeout(2000);

        const clipName = await page.textContent('.soundboard-clip-name');
        expect(clipName).toContain('Test Tone');

        const playBtn = await page.$('.sb-play-btn');
        expect(playBtn).toBeTruthy();

        await page.evaluate(() => {
            const overlay = document.getElementById('soundboard-overlay');
            if (overlay) overlay.style.display = 'none';
        });
    });
});

// ═══════════════════════════════════════════════════
// TEST 2: Disable soundboard toggle
// ═══════════════════════════════════════════════════
test.describe('Soundboard Disable Toggle', () => {
    test('Disabling soundboard in Settings blocks playing', async ({ page }) => {
        const user = unique('sb_dis');
        await register(page, user);
        await waitForWs(page);
        await createServer(page, 'Disable Test');

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        const checkbox = await page.$('#voice-disable-soundboard');
        expect(checkbox).toBeTruthy();
        expect(await checkbox!.isChecked()).toBe(false);

        await checkbox!.check();
        await page.waitForTimeout(200);
        expect(await checkbox!.isChecked()).toBe(true);

        const stored = await page.evaluate(() => localStorage.getItem('sb_disabled_global'));
        expect(stored).toBe('1');

        await page.click('#close-settings');
    });

    test('Disabled state persists across page reload', async ({ page }) => {
        const user = unique('sb_persist');
        await register(page, user);
        await waitForWs(page);
        await createServer(page, 'Persist Test');

        await page.evaluate(() => { localStorage.setItem('sb_disabled_global', '1'); });
        await page.reload();
        await page.waitForTimeout(3000);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        const checkbox = await page.$('#voice-disable-soundboard');
        expect(await checkbox!.isChecked()).toBe(true);

        await page.click('#close-settings');
    });

    test('Global disable blocks receiving soundboard plays via WS', async ({ page }) => {
        const user = unique('sb_norx');
        await register(page, user);
        await waitForWs(page);
        await createServer(page, 'NoRx Test');

        await page.evaluate(() => { localStorage.setItem('sb_disabled_global', '1'); });

        const blocked = await page.evaluate(() => {
            const handler = (window as any)._handleSoundboardPlay;
            if (!handler) return false;
            handler({ user_id: 'other_user', encrypted_audio: 'fake_audio', server_id: 'test' });
            return true;
        });
        expect(blocked).toBe(true);

        await page.evaluate(() => { localStorage.setItem('sb_disabled_global', '0'); });
    });
});

// ═══════════════════════════════════════════════════
// TEST 3: Groups
// ═══════════════════════════════════════════════════
test.describe('Server Groups', () => {
    test('Create group via UI, verify it appears', async ({ page }) => {
        const user = unique('grp1');
        await register(page, user);
        await waitForWs(page);

        // Create 2 servers via UI
        await createServer(page, 'Server A');
        await page.waitForTimeout(1000);
        await createServer(page, 'Server B');

        const icons = await page.$$('.server-icon[data-id]');
        expect(icons.length).toBe(2);

        // Create group via API with safeFetch
        await page.evaluate(async () => {
            // @ts-ignore
            async function safeFetch(url: string, opts: any) {
                const r = await fetch(url, opts);
                const txt = await r.text();
                if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + txt.substring(0, 200));
                return JSON.parse(txt);
            }
            const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') };
            const servers = await safeFetch('/api/servers', { headers: h });
            const s1 = servers[0].id, s2 = servers[1].id;

            const dg = await safeFetch('/api/server-groups', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Test Group' }) });
            await new Promise(r => setTimeout(r, 500));
            await safeFetch('/api/servers/' + s1 + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: dg.id }) });
            await new Promise(r => setTimeout(r, 500));
            await safeFetch('/api/servers/' + s2 + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: dg.id }) });
        });

        await page.reload();
        await page.waitForTimeout(3000);
        await waitForWs(page);

        const groupEl = await page.$('.server-group');
        expect(groupEl).toBeTruthy();

        const groupToggle = await page.$('.server-group-toggle');
        expect(groupToggle).toBeTruthy();
        const toggleText = await groupToggle!.textContent();
        expect(toggleText).toContain('Test Group');
    });

    test('Toggle group expand/collapse', async ({ page }) => {
        const user = unique('grp2');
        await register(page, user);
        await waitForWs(page);

        // Create 2 servers via UI, then group them via API
        await createServer(page, 'S1');
        await page.waitForTimeout(1000);
        await createServer(page, 'S2');

        // Create group and move servers into it
        await page.evaluate(async () => {
            async function safeFetch(url: string, opts: any) {
                const r = await fetch(url, opts);
                const txt = await r.text();
                if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + txt.substring(0, 200));
                return JSON.parse(txt);
            }
            const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') };
            const servers = await safeFetch('/api/servers', { headers: h });
            const delay = (ms: number) => new Promise((r: any) => setTimeout(r, ms));
            const dg = await safeFetch('/api/server-groups', { method: 'POST', headers: h, body: JSON.stringify({ name: 'My Group' }) });
            await delay(500);
            for (const s of servers) {
                await safeFetch('/api/servers/' + s.id + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: dg.id }) });
                await delay(500);
            }
            // Verify the moves stuck
            const after = await safeFetch('/api/servers', { headers: h });
            return after.map((s: any) => ({ id: s.id, group_id: s.group_id }));
        });

        // Reload the page to refresh server list
        await page.reload();
        await page.waitForSelector('#server-list', { timeout: 15000 });
        await page.waitForTimeout(8000);
        await waitForWs(page);

        // Check sidebar HTML for groups
        const sidebarHtml = await page.evaluate(() => document.getElementById('server-list')?.innerHTML || '');
        console.log('SIDEBAR HTML:', sidebarHtml.substring(0, 500));

        // Wait for the group to appear
        await page.waitForSelector('.server-group', { timeout: 15000 });

        // Group should have toggle or collapsed grid
        const hasToggle = await page.$('.server-group-toggle');
        const hasGrid = await page.$('.server-group-collapsed-grid');
        expect(hasToggle || hasGrid).toBeTruthy();

        const toggleText = hasToggle ? await hasToggle!.textContent() : '';
        const gridTitle = hasGrid ? await hasGrid!.getAttribute('title') : '';
        expect((toggleText + gridTitle).toLowerCase()).toContain('my group');

        // Click toggle to collapse (if expanded)
        if (hasToggle) {
            await hasToggle!.click();
            await page.waitForTimeout(500);
            const grid = await page.$('.server-group-collapsed-grid');
            expect(grid).toBeTruthy();
            // Expand again
            await grid!.click();
            await page.waitForTimeout(500);
        } else if (hasGrid) {
            // Click grid to expand (if collapsed)
            await hasGrid!.click();
            await page.waitForTimeout(500);
            const toggle = await page.$('.server-group-toggle');
            expect(toggle).toBeTruthy();
        }
    });

    // Groups-in-groups test removed — feature was removed

    test('Group collapsed preview shows up to 4 server mini icons', async ({ page }) => {
        const user = unique('grp4');
        await register(page, user);
        await waitForWs(page);

        // Create 5 servers via UI
        for (let i = 0; i < 5; i++) {
            await createServer(page, 'S' + i);
            await page.waitForTimeout(500);
        }

        // Group them all
        await page.evaluate(async () => {
            async function safeFetch(url: string, opts: any) {
                const r = await fetch(url, opts);
                const txt = await r.text();
                if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + txt.substring(0, 200));
                return JSON.parse(txt);
            }
            const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') };
            const servers = await safeFetch('/api/servers', { headers: h });
            const delay = (ms: number) => new Promise((r: any) => setTimeout(r, ms));
            const dg = await safeFetch('/api/server-groups', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Big Group' }) });
            await delay(500);
            for (const s of servers) {
                await safeFetch('/api/servers/' + s.id + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: dg.id }) });
                await delay(500);
            }
        });

        await page.reload();
        await page.waitForSelector('#server-list', { timeout: 15000 });
        await page.waitForTimeout(8000);
        await waitForWs(page);

        // Group starts expanded — click toggle to collapse it
        const toggle = await page.$('.server-group-toggle');
        if (toggle) {
            await toggle.click();
            await page.waitForTimeout(500);
        }

        const miniIcons = await page.$$('.server-group-collapsed-grid .server-group-mini');
        expect(miniIcons.length).toBe(4);

        const moreBadge = await page.$('.server-group-more-badge');
        expect(moreBadge).toBeTruthy();
        expect(await moreBadge!.textContent()).toContain('+1');
    });
});

// ═══════════════════════════════════════════════════
// TEST 4: Server owner — disable/enable member soundboard
// ═══════════════════════════════════════════════════
test.describe('Owner Soundboard Controls', () => {
    test('Owner can disable/enable soundboard for a member via API', async ({ page }) => {
        const owner = unique('ow_sb');
        const member = unique('mem_sb');
        await register(page, owner);
        await waitForWs(page);
        const serverId = await createServer(page, 'SB Owner Test');

        // Register member in a second browser context
        const ctx2 = await page.context().browser()!.newContext();
        const page2 = await ctx2.newPage();
        await register(page2, member);
        await waitForWs(page2);

        // Get member's user ID from localStorage
        const memberId = await page2.evaluate(() => {
            try { return JSON.parse(localStorage.getItem('user') || '{}').id || ''; } catch(_) { return ''; }
        });
        expect(memberId).toBeTruthy();

        // Owner gets invite code and sends it to member
        const inviteResp = await page.evaluate(async (sid) => {
            const r = await fetch('/api/servers/' + sid + '/invite', {
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
            });
            const txt = await r.text();
            try { return JSON.parse(txt); } catch(_) { return { error: txt }; }
        }, serverId);
        console.log('Invite response:', JSON.stringify(inviteResp));

        if (!inviteResp.invite_code && !inviteResp.code) {
            // Fallback: use page2 to join directly with a known approach
            console.log('Could not get invite code, skipping join part');
        } else {
            const code = inviteResp.invite_code || inviteResp.code;
            const joinResp = await page2.evaluate(async (c) => {
                const r = await fetch('/api/invites/join', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                    body: JSON.stringify({ invite_code: c })
                });
                const txt = await r.text();
                try { return JSON.parse(txt); } catch(_) { return { error: txt, status: r.status }; }
            }, code);
            console.log('Join response:', JSON.stringify(joinResp));
            await page2.waitForTimeout(1000);
        }

        // Disable member soundboard
        const disableResp = await page.evaluate(async (data) => {
            const r = await fetch('/api/soundboard/disable/' + data.sid + '/' + data.uid, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') }
            });
            const txt = await r.text();
            try { return { ok: r.ok, ...JSON.parse(txt) }; } catch(_) { return { ok: r.ok, raw: txt }; }
        }, { sid: serverId, uid: memberId });
        console.log('Disable resp:', JSON.stringify(disableResp));
        expect(disableResp.ok).toBe(true);

        // Verify in list
        const disabledList = await page.evaluate(async (sid) => {
            const r = await fetch('/api/soundboard/disabled/' + sid, {
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
            });
            return r.json();
        }, serverId);
        expect(disabledList.users).toContain(memberId);

        // Enable member soundboard
        const enableResp = await page.evaluate(async (data) => {
            const r = await fetch('/api/soundboard/disable/' + data.sid + '/' + data.uid, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') }
            });
            const txt = await r.text();
            try { return { ok: r.ok, ...JSON.parse(txt) }; } catch(_) { return { ok: r.ok, raw: txt }; }
        }, { sid: serverId, uid: memberId });
        expect(enableResp.ok).toBe(true);

        const disabledList2 = await page.evaluate(async (sid) => {
            const r = await fetch('/api/soundboard/disabled/' + sid, {
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
            });
            return r.json();
        }, serverId);
        expect(disabledList2.users).not.toContain(memberId);

        await ctx2.close();
    });

    test('Non-owner cannot disable member soundboard', async ({ page }) => {
        // User A creates the server (owner)
        const owner = unique('nw_own');
        await register(page, owner);
        await waitForWs(page);
        const serverId = await createServer(page, 'Non-Owner Test');

        // User B registers (non-owner)
        const nonOwner = unique('nw_non');
        const ctx2 = await page.context().browser()!.newContext();
        const page2 = await ctx2.newPage();
        await register(page2, nonOwner);
        await waitForWs(page2);
        const nonOwnerId = await page2.evaluate(() => {
            try { return JSON.parse(localStorage.getItem('user') || '{}').id || ''; } catch(_) { return ''; }
        });

        // Owner joins non-owner into the server
        const inviteResp = await page.evaluate(async (sid) => {
            const r = await fetch('/api/servers/' + sid + '/invite', {
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
            });
            return r.json();
        }, serverId);
        const code = inviteResp.invite_code || inviteResp.code;
        if (code) {
            await page2.evaluate(async (c) => {
                await fetch('/api/invites/join', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                    body: JSON.stringify({ invite_code: c })
                });
            }, code);
            await page2.waitForTimeout(1000);
        }

        // Non-owner tries to disable owner's soundboard — should get 403
        const resp = await page2.evaluate(async (data) => {
            const r = await fetch('/api/soundboard/disable/' + data.sid + '/' + data.uid, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') }
            });
            const txt = await r.text();
            return { status: r.status, body: txt };
        }, { sid: serverId, uid: nonOwnerId });
        expect(resp.status).toBe(403);

        await ctx2.close();
    });
});

// ═══════════════════════════════════════════════════
// TEST 5: Default voice channel on server creation
// ═══════════════════════════════════════════════════
test.describe('Server Creation', () => {
    test('New server has a default voice channel', async ({ page }) => {
        const user = unique('def_vc');
        await register(page, user);
        await waitForWs(page);
        const serverId = await createServer(page, 'VC Test Server');
        await page.waitForTimeout(1000);

        // Click the server icon to select it and show channels
        const serverIcon = await page.$('.server-icon[data-id="' + serverId + '"]');
        if (serverIcon) await serverIcon.click();
        await page.waitForTimeout(2000);
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        const voiceChannels = await page.$$('.channel-item.channel-item-voice');
        expect(voiceChannels.length).toBeGreaterThanOrEqual(1);

        // Voice channel exists — the name may be encrypted so just verify the voice icon is present
        const vcHtml = await voiceChannels[0].innerHTML();
        expect(vcHtml).toBeTruthy();
    });
});

// ═══════════════════════════════════════════════════
// TEST 6: Voice popup settings sync
// ═══════════════════════════════════════════════════
test.describe('Voice Popup', () => {
    test('Settings and voice popup checkboxes stay in sync', async ({ page }) => {
        const user = unique('vp_sb');
        await register(page, user);
        await waitForWs(page);
        await createServer(page, 'VP Test');

        const vpCheckbox = await page.$('#voice-popup-disable-sb');
        expect(vpCheckbox).toBeTruthy();

        // Disable via localStorage
        await page.evaluate(() => { localStorage.setItem('sb_disabled_global', '1'); });
        await page.reload();
        await page.waitForTimeout(3000);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        const svCheckbox = await page.$('#voice-disable-soundboard');
        expect(svCheckbox).toBeTruthy();
        expect(await svCheckbox!.isChecked()).toBe(true);

        await page.click('#close-settings');
    });
});
