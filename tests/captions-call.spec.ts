import { test, expect } from '@playwright/test';
import * as path from 'node:path';

/**
 * Live captions in a REAL call.
 *
 * `tests/captions-local.spec.ts` proves the engine can transcribe a window of
 * PCM that is handed to it directly. That left the actual wiring — a
 * participant's decrypted audio arriving over a call — completely untested, and
 * that is exactly where captions silently did nothing: `playRemoteAudio()`
 * attached the caption tap and then called `removeRemoteAudioEls()`, which
 * detaches the tap for a member who is leaving. attach-then-detach left the
 * engine with nobody attached, so a real call produced no captions at all while
 * the synthetic feed test kept passing.
 *
 * This spec closes that hole: a two-user DM call with Chrome's fake microphone
 * playing real speech, captions on the callee, and the assertion that the
 * callee's engine has that speaker attached AND produces a labelled line.
 */

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const WAV = path.join(__dirname, 'fixtures', 'hello-captions.wav');

test.use({
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            `--use-file-for-fake-audio-capture=${WAV}`,
        ],
    },
});

// Model load plus a couple of five-second windows.
test.describe.configure({ timeout: 300000 });

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: any) {
    await page.waitForFunction(
        () => typeof (window as any).ws !== 'undefined' && (window as any).ws && (window as any).ws.readyState === 1,
        null,
        { timeout: 20000 },
    );
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

async function createDm(page: any, body1: any, body2: any) {
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    expect(dm.id).toBeTruthy();
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

test('a real call attaches each participant and captions what they say', async ({ browser }) => {
    test.setTimeout(300000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();

    for (const p of [page, page2]) {
        // Voice settings are read before the app boots; noise suppression off so
        // nothing gates the fake microphone's speech.
        await p.addInitScript(() => {
            try {
                localStorage.setItem('voice_settings', JSON.stringify({
                    noiseSuppressionMode: 'off',
                    echoCancellation: false,
                    micVolume: 100,
                    speakerVolume: 100,
                }));
            } catch (_) {}
        });
    }

    const body1 = await registerUser(page, 'cc1_' + Date.now().toString().slice(-6));
    const body2 = await registerUser(page2, 'cc2_' + Date.now().toString().slice(-6));
    await waitForWs(page);
    await waitForWs(page2);
    await setupFriends(page, page2, body1, body2);
    await createDm(page, body1, body2);
    await page.reload();
    await page2.reload();
    await waitForWs(page);
    await waitForWs(page2);

    // The callee turns captions on BEFORE the call, which is the everyday
    // "turn it on, then talk" order.
    await page2.evaluate(() => {
        const t = document.getElementById('captions-toggle') as HTMLInputElement;
        t.checked = true;
        t.dispatchEvent(new Event('change'));
    });

    await openDm(page);
    await page.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 20000 });
    await page.click('.dm-call-btns .dm-call-btn');
    await page.waitForTimeout(2000);
    await page2.waitForSelector('#incoming-call-accept:visible', { timeout: 20000 });
    await page2.click('#incoming-call-accept');
    await page2.waitForTimeout(5000);

    const call = await page2.evaluate(() => {
        const V: any = (window as any).VoiceManager;
        const S = V && V._debug ? V._debug.state : null;
        const rs = (S && S.remoteStreams) || {};
        return {
            uids: Object.keys(rs),
            hasAudio: Object.keys(rs).filter((u) => !!(rs[u] && rs[u].audio)),
        };
    });
    expect(call.uids.length, 'the call must deliver the other participant').toBeGreaterThan(0);
    expect(call.hasAudio.length, 'their decrypted audio stream must exist').toBeGreaterThan(0);

    // The regression: the engine must actually be attached to that stream.
    await expect
        .poll(async () => page2.evaluate(() => (window as any).__captions.speakers()), { timeout: 30000 })
        .toContain(call.uids[0]);

    // And it must turn their speech into a labelled line.
    await expect
        .poll(async () => page2.evaluate(() => {
            const lines = (window as any).__captions.lines();
            return lines.length ? lines[lines.length - 1].who + ': ' + lines[lines.length - 1].text : '';
        }), { timeout: 180000 })
        .not.toBe('');

    const line = await page2.evaluate(() => {
        const lines = (window as any).__captions.lines();
        return lines[lines.length - 1];
    });
    expect(line.who, 'the line must be labelled with the speaker').toBeTruthy();

    // Turning captions off drops every line and releases the tap.
    await page2.evaluate(() => (window as any).__captions.stop());
    expect(await page2.evaluate(() => (window as any).__captions.lines().length)).toBe(0);
    expect(await page2.evaluate(() => (window as any).__captions.speakers().length)).toBe(0);

    await ctx.close();
    await ctx2.close();
});
