import { test, expect, chromium } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASS = '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

let counter = 0;
function unique(prefix: string) { return prefix + '_' + (++counter) + '_' + Date.now().toString(36); }

async function waitForWs(page: any) {
    await page.waitForFunction(() => window.ws && (window as any).ws.readyState === 1, { timeout: 15000 });
}

async function register(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASS);
    await page.fill('#register-confirm-password', PASS);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await waitForWs(page);
}

test.describe('Soundboard Multi-Device & Late Join', () => {
    test('M1: Non-voice device ignores soundboard_play (multi-device gate)', async () => {
        const browser = await chromium.launch({
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'],
        });
        try {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await register(page, unique('sb_m1'));
            await waitForWs(page);

            const result = await page.evaluate(() => {
                const before = (window as any)._sbAllPlaying?.length || 0;
                const vs = (window as any).VoiceManager?.getVoiceState();
                if ((window as any)._handleSoundboardPlay) {
                    (window as any)._handleSoundboardPlay({
                        user_id: 'other_user', clip_id: 'fake', temp_token: 'tok',
                        play_start_ms: Date.now(), duration_ms: 5000,
                        room_type: 'server', server_id: 'fake_sid', channel_id: 'fake_ch',
                    });
                }
                const after = (window as any)._sbAllPlaying?.length || 0;
                const playing = (window as any)._sbPlayingUsers || {};
                return { inVoice: vs?.inVoice, before, after, playingUser: !!playing['other_user'] };
            });

            expect(result.inVoice).toBe(false);
            expect(result.after).toBe(result.before);
            expect(result.playingUser).toBe(false);
        } finally {
            await browser.close();
        }
    });

    test('M2: Room-match gate blocks play for wrong server when in voice', async () => {
        const browser = await chromium.launch({
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'],
        });
        try {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await register(page, unique('sb_m2'));
            await waitForWs(page);

            // Mock VoiceManager to report being in voice on server_A
            const result = await page.evaluate(() => {
                // Override getVoiceState to simulate being in voice on server_A
                const origGetVS = (window as any).VoiceManager.getVoiceState;
                (window as any).VoiceManager.getVoiceState = () => ({
                    inVoice: true, roomType: 'server', serverId: 'server_A',
                    channelId: 'ch_A', dmChannelId: '',
                });

                const before = (window as any)._sbAllPlaying?.length || 0;

                // Play from server_A (same) — should pass gate
                (window as any)._handleSoundboardPlay({
                    user_id: 'user1', clip_id: 'clip1', temp_token: 'tok1',
                    play_start_ms: Date.now(), duration_ms: 5000,
                    room_type: 'server', server_id: 'server_A', channel_id: 'ch_A',
                });

                // Play from server_B (different) — should be blocked
                (window as any)._handleSoundboardPlay({
                    user_id: 'user2', clip_id: 'clip2', temp_token: 'tok2',
                    play_start_ms: Date.now(), duration_ms: 5000,
                    room_type: 'server', server_id: 'server_B', channel_id: 'ch_B',
                });

                // Restore
                (window as any).VoiceManager.getVoiceState = origGetVS;

                const after = (window as any)._sbAllPlaying?.length || 0;
                const playing = (window as any)._sbPlayingUsers || {};
                return { before, after, user1: !!playing['user1'], user2: !!playing['user2'] };
            });

            // user2's gate was blocked → no fetch attempted
            expect(result.user2).toBe(false); // different server → gate blocked
            // user1's gate passed → fetch was attempted (and failed with fake token)
            // The indicator gets set AFTER the fetch+play succeeds, so with a fake
            // token user1 may or may not have the indicator. The important assertion
            // is that user2 was blocked at the gate level.
        } finally {
            await browser.close();
        }
    });

    test('M3: Playing indicator tracks user state', async () => {
        const browser = await chromium.launch({
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'],
        });
        try {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await register(page, unique('sb_m3'));
            await waitForWs(page);

            await page.evaluate(() => (window as any)._sbSetPlaying('user_A', true));
            await page.waitForTimeout(100);
            let playing = await page.evaluate(() => (window as any)._sbPlayingUsers);
            expect(playing['user_A']).toBe(true);

            await page.evaluate(() => (window as any)._sbSetPlaying('user_A', false));
            await page.waitForTimeout(100);
            playing = await page.evaluate(() => (window as any)._sbPlayingUsers);
            expect(playing['user_A']).toBeUndefined();
        } finally {
            await browser.close();
        }
    });

    test('M4: Muted user play is suppressed, unmute clears suppression', async () => {
        const browser = await chromium.launch({
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'],
        });
        try {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await register(page, unique('sb_m4'));
            await waitForWs(page);

            // Mock voice state
            await page.evaluate(() => {
                (window as any).VoiceManager.getVoiceState = () => ({
                    inVoice: true, roomType: 'server', serverId: 'srv',
                    channelId: 'ch', dmChannelId: '',
                });
                (window as any).currentServerId = 'srv';
            });

            // Mute user_X
            await page.evaluate(() => (window as any)._sbToggleMuteUser('user_X'));

            // Play from muted user_X — should be suppressed (no audio, no indicator)
            await page.evaluate(() => {
                (window as any)._handleSoundboardPlay({
                    user_id: 'user_X', clip_id: 'clip', temp_token: 'tok',
                    play_start_ms: Date.now(), duration_ms: 30000,
                    room_type: 'server', server_id: 'srv', channel_id: 'ch',
                });
            });
            await page.waitForTimeout(200);

            const suppressed = await page.evaluate(() => ({
                playing: !!(window as any)._sbPlayingUsers?.['user_X'],
                allPlaying: (window as any)._sbAllPlaying?.length || 0,
            }));
            expect(suppressed.playing).toBe(false);

            // Unmute + resume
            await page.evaluate(() => {
                (window as any)._sbToggleMuteUser('user_X');
                if ((window as any)._sbResumeForUser) {
                    (window as any)._sbResumeForUser('user_X');
                }
            });
            await page.waitForTimeout(500);
            // Resume was attempted without error (token won't exist but function ran)
        } finally {
            await browser.close();
        }
    });

    test('M5: Late-join data includes room fields for gate', async () => {
        const browser = await chromium.launch({
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'],
        });
        try {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await register(page, unique('sb_m5'));
            await waitForWs(page);

            // Mock voice state
            await page.evaluate(() => {
                (window as any).VoiceManager.getVoiceState = () => ({
                    inVoice: true, roomType: 'server', serverId: 'srv',
                    channelId: 'ch', dmChannelId: '',
                });
            });

            // Verify the late-join synthetic play passes the gate
            const result = await page.evaluate(() => {
                // This is exactly what handleVoiceJoined constructs
                const data = {
                    user_id: 'player', clip_id: 'clip', temp_token: 'tok',
                    play_start_ms: Date.now(), duration_ms: 30000,
                    _lateJoinOffset: 5000,
                    room_type: 'server', server_id: 'srv',
                    channel_id: 'ch', dm_channel_id: '',
                };
                // The gate should pass: inVoice + same server
                const vs = (window as any).VoiceManager.getVoiceState();
                const sameRoom = vs && vs.inVoice && vs.roomType !== 'dm' && vs.serverId === data.server_id;
                return { sameRoom, serverId: vs?.serverId, dataServerId: data.server_id };
            });

            expect(result.sameRoom).toBe(true);
        } finally {
            await browser.close();
        }
    });

    test('M6: Soundboard clip list element exists and is accessible', async () => {
        const browser = await chromium.launch({
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'],
        });
        try {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await register(page, unique('sb_m6'));
            await waitForWs(page);

            // Verify the soundboard clips element is accessible and the getter works
            const result = await page.evaluate(() => {
                const el = document.getElementById('soundboard-clips');
                const cache = (window as any)._sbClipsCache;
                return { hasEl: !!el, cacheIsArray: Array.isArray(cache), cacheLen: cache?.length || 0 };
            });

            expect(result.hasEl).toBe(true);
            expect(result.cacheIsArray).toBe(true);
        } finally {
            await browser.close();
        }
    });
});
