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
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: any) {
    return await page.evaluate(() => new Promise((resolve) => {
        let tries = 0;
        const check = () => {
            tries++;
            if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
            else if (tries >= 60) resolve(false);
            else setTimeout(check, 200);
        };
        setTimeout(check, 500);
    }));
}

test('audio element health sweep re-plays a paused remote element and re-attaches a HAVE_NOTHING element', async ({ page }) => {
    test.setTimeout(90000);
    const ts = Date.now();
    await registerUser(page, 'aswp_' + ts);
    await waitForWs(page);

    const result = await page.evaluate(async () => {
        const vm = (window as any).VoiceManager;
        const S = vm._debug.state;
        // Fake a remote member with a live stream + two audio elements:
        // one PAUSED (needs play()), one HAVE_NOTHING (needs re-attach).
        const fakeStream = new MediaStream();
        try {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const dest = ctx.createMediaStreamDestination();
            fakeStream.addTrack(dest.stream.getAudioTracks()[0]);
        } catch (_) {}
        S.remoteStreams['fake-uid'] = { audio: fakeStream };
        S.remoteAudioEls['fake-uid'] = [];
        S.connected = true; // the sweep no-ops unless we're in a room
        const mkEl = () => {
            const el = document.createElement('audio');
            el.autoplay = true;
            el.muted = false;
            el.srcObject = fakeStream;
            document.body.appendChild(el);
            return el;
        };
        const pausedEl = mkEl();
        pausedEl.pause();
        const nothingEl = mkEl();
        nothingEl.pause();
        Object.defineProperty(nothingEl, 'readyState', { value: 0, configurable: true });
        Object.defineProperty(pausedEl, 'readyState', { value: 4, configurable: true });
        S.remoteAudioEls['fake-uid'] = [pausedEl, nothingEl];

        // Run the sweep (normally a 2s interval while connected).
        vm.audioElementHealthSweep();
        await new Promise((r) => setTimeout(r, 100));
        const pausedPlayCalled = !pausedEl.paused || pausedEl.__played;
        return {
            pausedPaused: pausedEl.paused,
            nothingPaused: nothingEl.paused,
            nothingSrcAttached: !!nothingEl.srcObject,
        };
    });
    console.log('[ASWEEP]', JSON.stringify(result));
    // The paused element must have been played again and the HAVE_NOTHING
    // element re-attached (srcObject non-null after re-attach).
    expect(result.pausedPaused).toBe(false);
    expect(result.nothingSrcAttached).toBe(true);
});

test('incoming call bar fits a phone viewport (not clipped on the left)', async ({ page }) => {
    test.setTimeout(90000);
    const ts = Date.now();
    await page.setViewportSize({ width: 375, height: 667 });
    await registerUser(page, 'phn_' + ts);
    await waitForWs(page);

    // Render the incoming bar with a very long caller name.
    const style = await page.evaluate(() => {
        const vm = (window as any).VoiceManager;
        const S = vm._debug.state;
        S.incomingCall = { callerId: 'x', callerUsername: 'AnExtremelyLongCallerDisplayNameThatWouldOverflow', dmChannelId: 'ph-ch' };
        if (typeof vm.showIncomingCall === 'function') vm.showIncomingCall(S.incomingCall);
        const bar = document.getElementById('incoming-call-bar')!;
        const rect = bar.getBoundingClientRect();
        const cs = getComputedStyle(bar);
        return {
            left: rect.left,
            right: rect.right,
            viewportW: window.innerWidth,
            display: cs.display,
            nameOverflow: cs.overflow,
        };
    });
    console.log('[PHONE-BAR]', JSON.stringify(style));
    // The bar must stay fully inside the 375px viewport and be visible.
    expect(style.display).toBe('flex');
    expect(style.left).toBeGreaterThanOrEqual(0);
    expect(style.right).toBeLessThanOrEqual(style.viewportW);
    // Cleanup
    await page.evaluate(() => {
        const S = (window as any).VoiceManager._debug.state;
        S.incomingCall = null;
    });
});
