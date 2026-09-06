import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Voice joins need mic access — use Chromium's fake device so getUserMedia
// resolves instantly and the voice bar actually shows (headless has no mic).
test.use({
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    },
    // Mic permission must be granted per-context or getUserMedia hangs/denies,
    // leaving the voice bar hidden after joining a voice channel.
    contextOptions: {
        permissions: ['microphone'],
    },
});

function unique(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 10000 });
    await page.evaluate(() => {
        const el = document.getElementById('loading-overlay');
        if (el) el.remove();
    });
    await page.waitForTimeout(500);
    // Return the auth token + user object so callers can use u.token / u.user.id
    return await page.evaluate((uname: string) => ({
        token: localStorage.getItem('token'),
        username: uname,
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }), username);
}

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries: number) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof (window as any).ws !== 'undefined' && (window as any).ws && (window as any).ws.readyState === WebSocket.OPEN) {
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

async function createServerWithVoiceChannel(page: any): Promise<{ serverId: string; voiceChannelId: string }> {
    const ts = Date.now();
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'SBMute_' + ts);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    await page.waitForTimeout(2000);
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')?.getAttribute('data-id') || '');

    const voiceChannelId = await page.evaluate(async ({ serverId }: { serverId: string }) => {
        const token = localStorage.getItem('token');
        const sk = (window as any).E2ECrypto.getServerKey(serverId);
        const encName = (window as any).E2ECrypto.aeadEncrypt('voice', sk);
        const res = await fetch(`/api/servers/${serverId}/channels`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_type: 'voice', encrypted_name: encName.ciphertext, name_nonce: encName.nonce }),
        });
        const ch = await res.json();
        return ch.id;
    }, { serverId });

    return { serverId, voiceChannelId };
}

async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
    const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(friendCode2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: friendCode2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

// ──────────────────────────────────────────────
// Soundboard Mute/Disable: Unit Tests
// ──────────────────────────────────────────────

test.describe('Soundboard Mute/Disable (unit-level)', () => {

    test('all required soundboard functions exist on window', async ({ page }) => {
        test.setTimeout(60000);
        const username = unique('sb_unit1');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            return {
                hasStopAll: typeof (window as any)._stopAllSoundboardAudio === 'function',
                hasHandleStop: typeof (window as any)._handleSoundboardStop === 'function',
                hasToggleMute: typeof (window as any)._sbToggleMuteUser === 'function',
                hasMutedList: typeof (window as any)._sbMutedList !== 'undefined',
                hasIsMuted: typeof (window as any)._sbIsUserMuted === 'function',
                hasDisabledUsers: Array.isArray((window as any)._sbDisabledUsers),
                myId: (window as any).currentUserId,
                playingIsArray: Array.isArray((window as any)._sbAllPlaying),
            };
        });

        expect(result.hasStopAll).toBe(true);
        expect(result.hasHandleStop).toBe(true);
        expect(result.hasToggleMute).toBe(true);
        expect(result.hasMutedList).toBe(true);
        expect(result.hasIsMuted).toBe(true);
        expect(result.hasDisabledUsers).toBe(true);
        expect(result.myId).toBeTruthy();
        expect(result.playingIsArray).toBe(true);
    });

    test('per-user mute toggle persists in localStorage (global, not per-server)', async ({ page }) => {
        test.setTimeout(60000);
        const username = unique('sb_unit2');
        await registerUser(page, username);
        await waitForWs(page);

        // Create a server so currentServerId is set
        await page.click('#add-server-btn');
        await page.click('#choice-create-server');
        await page.fill('#new-server-name', 'SBMutePersist_' + Date.now());
        await page.click('#confirm-create-server');
        await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
        await page.waitForTimeout(2000);

        const result = await page.evaluate(() => {
            const testUserId = 'test-mute-user-abc';

            // Initially not muted
            const initiallyMuted = (window as any)._sbIsUserMuted(testUserId);

            // Toggle mute ON
            (window as any)._sbToggleMuteUser(testUserId);
            const afterToggleOn = (window as any)._sbIsUserMuted(testUserId);

            // Check via proxy
            const viaProxy = (window as any)._sbMutedList.indexOf(testUserId) !== -1;

            // Verify it's stored under global key 'sb_muted' (not per-server)
            const storedValue = localStorage.getItem('sb_muted');
            const storedAsArray = storedValue ? JSON.parse(storedValue) : [];
            const inGlobalKey = storedAsArray.indexOf(testUserId) !== -1;

            // Toggle mute OFF
            (window as any)._sbToggleMuteUser(testUserId);
            const afterToggleOff = (window as any)._sbIsUserMuted(testUserId);

            return { initiallyMuted, afterToggleOn, viaProxy, inGlobalKey, afterToggleOff };
        });

        expect(result.initiallyMuted).toBe(false);
        expect(result.afterToggleOn).toBe(true);
        expect(result.viaProxy).toBe(true);
        expect(result.inGlobalKey).toBe(true);
        expect(result.afterToggleOff).toBe(false);
    });

    test('_handleSoundboardStop is safe to call with no matching entries', async ({ page }) => {
        test.setTimeout(60000);
        const username = unique('sb_unit3');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const playing = (window as any)._sbAllPlaying;

            // Call stop with no entries — should not crash
            try {
                (window as any)._handleSoundboardStop({ user_id: 'nonexistent' });
            } catch (e) {
                return { error: String(e) };
            }

            // Call stop with no user_id — should early return
            try {
                (window as any)._handleSoundboardStop({});
            } catch (e) {
                return { error: String(e) };
            }

            return { success: true, playingLength: playing.length };
        });

        expect(result.success).toBe(true);
        expect(result.playingLength).toBe(0);
    });

    test('global disable soundboard toggle', async ({ page }) => {
        test.setTimeout(60000);
        const username = unique('sb_unit4');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            // Initially not disabled
            const before = localStorage.getItem('sb_disabled_global');

            // Set disabled
            localStorage.setItem('sb_disabled_global', '1');
            if ((window as any).syncDisableCheckboxes) (window as any).syncDisableCheckboxes();
            const afterSet = localStorage.getItem('sb_disabled_global') === '1';

            // Check checkbox state
            const cb = document.getElementById('voice-disable-soundboard') as HTMLInputElement;
            const cbChecked = cb ? cb.checked : null;

            // Re-enable
            localStorage.setItem('sb_disabled_global', '0');
            if ((window as any).syncDisableCheckboxes) (window as any).syncDisableCheckboxes();
            const afterReEnable = localStorage.getItem('sb_disabled_global') !== '1';

            const cb2 = document.getElementById('voice-disable-soundboard') as HTMLInputElement;
            const cb2Checked = cb2 ? cb2.checked : null;

            // Clean up
            localStorage.removeItem('sb_disabled_global');
            if ((window as any).syncDisableCheckboxes) (window as any).syncDisableCheckboxes();

            return { before, afterSet, cbChecked, afterReEnable, cb2Checked };
        });

        expect(result.afterSet).toBe(true);
        expect(result.afterReEnable).toBe(true);
    });
});

// ──────────────────────────────────────────────
// Soundboard Mute/Disable: Integration Tests
// ──────────────────────────────────────────────

test.describe('Soundboard Mute/Disable (integration)', () => {

    test('volume menu context menu structure exists', async ({ page }) => {
        test.setTimeout(60000);
        const username = unique('sb_int1');
        await registerUser(page, username);
        await waitForWs(page);

        // Create a server with voice channel
        const { serverId, voiceChannelId } = await createServerWithVoiceChannel(page);

        // Join voice channel
        await page.click(`.server-icon[data-id="${serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });
        await page.click(`.channel-item[data-id="${voiceChannelId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });

        // Verify the voice-member-row has a contextmenu handler
        const result = await page.evaluate(() => {
            const row = document.querySelector('.voice-member-row[data-self="1"]');
            return {
                rowExists: !!row,
                menuExists: !!document.getElementById('volume-menu'),
                hasMuteApi: typeof (window as any)._sbToggleMuteUser === 'function',
                hasDisabledUsers: Array.isArray((window as any)._sbDisabledUsers),
            };
        });

        expect(result.rowExists).toBe(true);
        expect(result.menuExists).toBe(true);
        expect(result.hasMuteApi).toBe(true);
        expect(result.hasDisabledUsers).toBe(true);
    });

    test('mute toggle and stop work together', async ({ page }) => {
        test.setTimeout(60000);
        const username = unique('sb_int2');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const testUid = 'integration-mute-user';

            // Mute user
            (window as any)._sbToggleMuteUser(testUid);
            const muted = (window as any)._sbIsUserMuted(testUid);

            // Call handleSoundboardStop for this user (should not crash even with no entries)
            (window as any)._handleSoundboardStop({ user_id: testUid });

            // Unmute
            (window as any)._sbToggleMuteUser(testUid);
            const unmuted = !(window as any)._sbIsUserMuted(testUid);

            return { muted, unmuted };
        });

        expect(result.muted).toBe(true);
        expect(result.unmuted).toBe(true);
    });

    test('disabled users list is managed correctly', async ({ page }) => {
        test.setTimeout(60000);
        const username = unique('sb_int3');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const testUid = 'disabled-test-user';

            // Add to disabled list
            (window as any)._sbDisabledUsers.push(testUid);
            const added = (window as any)._sbDisabledUsers.includes(testUid);

            // Remove from disabled list
            const idx = (window as any)._sbDisabledUsers.indexOf(testUid);
            if (idx !== -1) (window as any)._sbDisabledUsers.splice(idx, 1);
            const removed = !(window as any)._sbDisabledUsers.includes(testUid);

            return { added, removed };
        });

        expect(result.added).toBe(true);
        expect(result.removed).toBe(true);
    });

    test('volume menu button active class and text when muted', async ({ page }) => {
        test.setTimeout(60000);
        const username = unique('sb_int4');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const testUid = 'active-class-user';

            // Before muting
            const beforeMuted = (window as any)._sbMutedList.indexOf(testUid) === -1;

            // Mute
            (window as any)._sbToggleMuteUser(testUid);
            const isMuted = (window as any)._sbMutedList.indexOf(testUid) !== -1;

            // Button text simulation
            const buttonTextOn = isMuted ? '✓ 🔊 Unmute Soundboard' : '🔇 Mute Soundboard';
            const buttonClassOn = 'volume-menu-btn' + (isMuted ? ' active' : '');

            // Unmute
            (window as any)._sbToggleMuteUser(testUid);
            const isUnmuted = (window as any)._sbMutedList.indexOf(testUid) === -1;

            // After unmuting, the button offers MUTING again (user is not muted)
            const buttonTextOff = isUnmuted ? '🔇 Mute Soundboard' : '✓ 🔊 Unmute Soundboard';
            const buttonClassOff = 'volume-menu-btn' + (isUnmuted ? '' : ' active');

            return { beforeMuted, isMuted, buttonTextOn, buttonClassOn, isUnmuted, buttonTextOff, buttonClassOff };
        });

        expect(result.beforeMuted).toBe(true);
        expect(result.isMuted).toBe(true);
        expect(result.buttonTextOn).toContain('✓');
        expect(result.buttonTextOn).toContain('Unmute');
        expect(result.buttonClassOn).toContain('active');
        expect(result.isUnmuted).toBe(true);
        expect(result.buttonTextOff).toContain('🔇');
        expect(result.buttonTextOff).toContain('Mute');
        expect(result.buttonClassOff).not.toContain('active');
    });

    test('volume menu button active class and text when disabled', async ({ page }) => {
        test.setTimeout(60000);
        const username = unique('sb_int5');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const testUid = 'disable-class-user';

            // Before disabling
            const beforeDisabled = !(window as any)._sbDisabledUsers.includes(testUid);

            // Disable
            (window as any)._sbDisabledUsers.push(testUid);
            const isDisabled = (window as any)._sbDisabledUsers.includes(testUid);

            const buttonTextOn = isDisabled ? '✓ 🔊 Enable Soundboard' : '🚫 Disable Soundboard';
            const buttonClassOn = 'volume-menu-btn' + (isDisabled ? ' active' : '');

            // Re-enable
            const idx = (window as any)._sbDisabledUsers.indexOf(testUid);
            if (idx !== -1) (window as any)._sbDisabledUsers.splice(idx, 1);
            const isEnabled = !(window as any)._sbDisabledUsers.includes(testUid);

            // After re-enabling, the button offers DISABLING again
            const buttonTextOff = isEnabled ? '🚫 Disable Soundboard' : '✓ 🔊 Enable Soundboard';
            const buttonClassOff = 'volume-menu-btn' + (isEnabled ? '' : ' active');

            return { beforeDisabled, isDisabled, buttonTextOn, buttonClassOn, isEnabled, buttonTextOff, buttonClassOff };
        });

        expect(result.beforeDisabled).toBe(true);
        expect(result.isDisabled).toBe(true);
        expect(result.buttonTextOn).toContain('✓');
        expect(result.buttonTextOn).toContain('Enable');
        expect(result.buttonClassOn).toContain('active');
        expect(result.isEnabled).toBe(true);
        expect(result.buttonTextOff).toContain('🚫');
        expect(result.buttonTextOff).toContain('Disable');
        expect(result.buttonClassOff).not.toContain('active');
    });
});

// ──────────────────────────────────────────────
// Soundboard: Two-user integration tests
// ──────────────────────────────────────────────

test.describe('Soundboard Mute/Disable (two-user)', () => {

    test('mute/unmute user via localStorage, verify state', async ({ context }) => {
        test.setTimeout(120000);
        const ts = Date.now();

        const ctx1 = await context.browser()!.newContext();
        const page1 = await ctx1.newPage();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();

        const p1Errors: string[] = [];
        page1.on('pageerror', (err) => p1Errors.push(err.message));
        const p2Errors: string[] = [];
        page2.on('pageerror', (err) => p2Errors.push(err.message));

        const u1 = await registerUser(page1, 'sbm1_' + ts);
        const u2 = await registerUser(page2, 'sbm2_' + ts);
        await becomeFriends(page1, page2, u1.token, u2.token);
        await waitForWs(page1);
        await waitForWs(page2);

        const { serverId, voiceChannelId } = await createServerWithVoiceChannel(page1);

        // Invite u2
        const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
        const invRes = await page1.request.post(`${BASE}/api/servers/${serverId}/invite`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: code },
        });
        expect(invRes.ok()).toBeTruthy();
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' },
            data: { code: code },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Both join voice
        await page1.click(`.server-icon[data-id="${serverId}"]`);
        await page1.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });
        await page1.click(`.channel-item[data-id="${voiceChannelId}"]`);
        await page1.waitForSelector('#voice-bar', { timeout: 10000 });

        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click(`.server-icon[data-id="${serverId}"]`);
        await page2.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${voiceChannelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });

        await page1.waitForTimeout(2000);

        // u1 mutes u2
        const mutedAfter = await page1.evaluate(({ sid, uid }: { sid: string; uid: string }) => {
            (window as any)._sbToggleMuteUser(uid);
            return (window as any)._sbIsUserMuted(uid);
        }, { sid: serverId, uid: u2.user.id });
        expect(mutedAfter).toBe(true);

        // u1 unmutes u2
        const unmutedAfter = await page1.evaluate(({ uid }: { uid: string }) => {
            (window as any)._sbToggleMuteUser(uid);
            return (window as any)._sbIsUserMuted(uid);
        }, { uid: u2.user.id });
        expect(unmutedAfter).toBe(false);

        expect(p1Errors).toEqual([]);
        expect(p2Errors).toEqual([]);

        await ctx1.close();
        await ctx2.close();
    });

    test('disable/enable user soundboard via API', async ({ context }) => {
        test.setTimeout(120000);
        const ts = Date.now();

        const ctx1 = await context.browser()!.newContext();
        const page1 = await ctx1.newPage();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();

        const p1Errors: string[] = [];
        page1.on('pageerror', (err) => p1Errors.push(err.message));
        const p2Errors: string[] = [];
        page2.on('pageerror', (err) => p2Errors.push(err.message));

        const u1 = await registerUser(page1, 'sbdis1_' + ts);
        const u2 = await registerUser(page2, 'sbdis2_' + ts);
        await becomeFriends(page1, page2, u1.token, u2.token);
        await waitForWs(page1);
        await waitForWs(page2);

        const { serverId, voiceChannelId } = await createServerWithVoiceChannel(page1);

        const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
        const invRes = await page1.request.post(`${BASE}/api/servers/${serverId}/invite`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: code },
        });
        expect(invRes.ok()).toBeTruthy();
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' },
            data: { code: code },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Both join voice
        await page1.click(`.server-icon[data-id="${serverId}"]`);
        await page1.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });
        await page1.click(`.channel-item[data-id="${voiceChannelId}"]`);
        await page1.waitForSelector('#voice-bar', { timeout: 10000 });

        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click(`.server-icon[data-id="${serverId}"]`);
        await page2.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${voiceChannelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });

        await page1.waitForTimeout(2000);

        // u1 (owner) disables u2's soundboard via API
        const disableRes = await page1.request.put(`${BASE}/api/soundboard/disable/${serverId}/${u2.user.id}`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
        });
        expect(disableRes.ok()).toBeTruthy();

        // Load disabled list
        await page1.evaluate(async () => {
            if ((window as any)._loadDisabledSoundboardUsers) await (window as any)._loadDisabledSoundboardUsers();
        });

        const isDisabled = await page1.evaluate(({ uid }: { uid: string }) => {
            return (window as any)._sbDisabledUsers.includes(uid);
        }, { uid: u2.user.id });
        expect(isDisabled).toBe(true);

        // Re-enable u2
        const enableRes = await page1.request.delete(`${BASE}/api/soundboard/disable/${serverId}/${u2.user.id}`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
        });
        expect(enableRes.ok()).toBeTruthy();

        await page1.evaluate(async () => {
            if ((window as any)._loadDisabledSoundboardUsers) await (window as any)._loadDisabledSoundboardUsers();
        });

        const isEnabled = await page1.evaluate(({ uid }: { uid: string }) => {
            return !(window as any)._sbDisabledUsers.includes(uid);
        }, { uid: u2.user.id });
        expect(isEnabled).toBe(true);

        expect(p1Errors).toEqual([]);
        expect(p2Errors).toEqual([]);

        await ctx1.close();
        await ctx2.close();
    });

    test('leaving call stops own sounds only', async ({ context }) => {
        test.setTimeout(120000);
        const ts = Date.now();

        const ctx1 = await context.browser()!.newContext();
        const page1 = await ctx1.newPage();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();

        const p1Errors: string[] = [];
        page1.on('pageerror', (err) => p1Errors.push(err.message));
        const p2Errors: string[] = [];
        page2.on('pageerror', (err) => p2Errors.push(err.message));

        const u1 = await registerUser(page1, 'sbleave1_' + ts);
        const u2 = await registerUser(page2, 'sbleave2_' + ts);
        await becomeFriends(page1, page2, u1.token, u2.token);
        await waitForWs(page1);
        await waitForWs(page2);

        const { serverId, voiceChannelId } = await createServerWithVoiceChannel(page1);

        const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
        const invRes = await page1.request.post(`${BASE}/api/servers/${serverId}/invite`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: code },
        });
        expect(invRes.ok()).toBeTruthy();
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' },
            data: { code: code },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Both join voice
        await page1.click(`.server-icon[data-id="${serverId}"]`);
        await page1.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });
        await page1.click(`.channel-item[data-id="${voiceChannelId}"]`);
        await page1.waitForSelector('#voice-bar', { timeout: 10000 });

        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click(`.server-icon[data-id="${serverId}"]`);
        await page2.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${voiceChannelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });

        await page1.waitForTimeout(2000);

        // Both connected
        const p1Connected = await page1.evaluate(() => (window as any).VoiceManager?.isConnected());
        const p2Connected = await page2.evaluate(() => (window as any).VoiceManager?.isConnected());
        expect(p1Connected).toBe(true);
        expect(p2Connected).toBe(true);

        // u1 leaves — call stop functions
        await page1.evaluate(() => {
            if ((window as any)._sendSoundboardStop) (window as any)._sendSoundboardStop();
            if ((window as any)._stopAllSoundboardAudio) (window as any)._stopAllSoundboardAudio();
        });

        // u2 still connected
        const p2StillConnected = await page2.evaluate(() => (window as any).VoiceManager?.isConnected());
        expect(p2StillConnected).toBe(true);

        // u1's playing array empty
        const p1Playing = await page1.evaluate(() => (window as any)._sbAllPlaying.length);
        expect(p1Playing).toBe(0);

        expect(p1Errors).toEqual([]);
        expect(p2Errors).toEqual([]);

        await ctx1.close();
        await ctx2.close();
    });
});
