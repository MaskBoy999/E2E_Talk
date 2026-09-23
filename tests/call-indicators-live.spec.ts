import { test, expect } from '@playwright/test';

// E2E_TEST_BASE_URL lets the suite run against a second, isolated server
// instance (its own DB and raised rate limits) without disturbing a dev server.
const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

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

async function setupFriends(pageA: any, pageB: any, bodyA: any, bodyB: any) {
    const fcB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await pageA.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fcB },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await pageB.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${bodyB.token}` },
    })).json();
    const acc = await pageB.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function createDm(pageA: any, bodyA: any, bodyB: any) {
    const userData = await (await pageA.request.get(`${BASE}/api/user/${bodyB.user.username}`, {
        headers: { Authorization: `Bearer ${bodyA.token}` },
    })).json();
    const dm = await (await pageA.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${bodyA.token}` },
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
    await page.waitForFunction(() => typeof viewMode !== 'undefined' && viewMode === 'dms', undefined, { timeout: 10000 });
}

async function rowBadges(page: any, dmId: string) {
    return await page.evaluate((dmId) => {
        const row = document.querySelector(`.dm-item[data-dm-id="${dmId}"]`);
        if (!row) return [];
        const badges: string[] = [];
        row.querySelectorAll('.dm-calling-dot, .dm-waiting-dot, .dm-connected-dot, .dm-for-us-dot').forEach((b) => {
            badges.push(b.className);
        });
        return badges;
    }, dmId);
}

test('DM-list indicators update live on BOTH sides; refresh clears only your own waiting marker', async ({ page, context }) => {
    test.setTimeout(180000);
    const ts = Date.now();
    const userA = 'liv1_' + ts;
    const userB = 'liv2_' + ts;
    const ctxB = await context.browser()!.newContext();
    const pageB = await ctxB.newPage();
    const bodyB = await registerUser(pageB, userB);
    const bodyA = await registerUser(page, userA);
    await setupFriends(page, pageB, bodyA, bodyB);
    const { userData, dm } = await createDm(page, bodyA, bodyB);
    await waitForWs(page);
    await waitForWs(pageB);
    await page.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(4000));
    await pageB.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(4000));

    await openDm(page);
    await openDm(pageB);

    // A calls B — the RING must surface live on BOTH rows (green), not just the caller's.
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: userB });
    await page.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-calling-dot`, { timeout: 15000 });
    await pageB.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-calling-dot`, { timeout: 15000 });
    expect(await rowBadges(page, dm.id)).toContain('dm-calling-dot');
    expect(await rowBadges(pageB, dm.id)).toContain('dm-calling-dot');
    console.log('[LIVE] ring badge on both rows');

    // B declines → LIVE flip on both: A amber (waiting with them), B red (waiting for us).
    await pageB.evaluate(() => (window as any).VoiceManager.declineDmCall());
    await page.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-waiting-dot`, { timeout: 15000 });
    await pageB.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-for-us-dot`, { timeout: 15000 });
    expect(await rowBadges(page, dm.id)).toContain('dm-waiting-dot');
    expect(await rowBadges(pageB, dm.id)).toContain('dm-for-us-dot');
    console.log('[LIVE] decline flipped both rows');

    // --- CALLEE (B) refreshes while A is still waiting in the room: B's red
    // marker is about the OTHER side's room, so it must SURVIVE the refresh.
    await pageB.reload();
    await pageB.waitForURL('**/index.html', { timeout: 15000 });
    await waitForWs(pageB);
    await pageB.waitForTimeout(2500);
    await openDm(pageB);
    await pageB.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-for-us-dot`, { timeout: 20000 });
    expect(await rowBadges(pageB, dm.id)).toContain('dm-for-us-dot');
    console.log('[LIVE] callee refresh keeps the red marker');

    // --- CALLER/WAITER (A) refreshes: the call CLOSES (refresh leaves all
    // calls) — A's own self-referencing marker is stale and must NOT show
    // "waiting for B" anymore.
    await page.reload();
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await waitForWs(page);
    await page.waitForTimeout(2500);
    await openDm(page);
    await page.waitForTimeout(800);
    const aAfter = await rowBadges(page, dm.id);
    console.log('[LIVE] caller after refresh:', JSON.stringify(aAfter));
    expect(aAfter).not.toContain('dm-waiting-dot');
    expect(aAfter).not.toContain('dm-calling-dot');
    // No phantom "waiting" state either.
    const aState = await page.evaluate((dmId) => (window as any).VoiceManager.getWaitingCall(dmId), dm.id);
    expect(aState).toBeNull();
    console.log('[LIVE] caller refresh cleared own marker');
});

test('callee ring badge pulses FAST (green) only while ringing, then drops instantly to the calm red badge on timeout', async ({ page, context }) => {
    test.setTimeout(120000);
    const ts = Date.now();
    const userA = 'pul1_' + ts;
    const userB = 'pul2_' + ts;
    const ctxB = await context.browser()!.newContext();
    const pageB = await ctxB.newPage();
    const bodyB = await registerUser(pageB, userB);
    const bodyA = await registerUser(page, userA);
    await setupFriends(page, pageB, bodyA, bodyB);
    const { userData, dm } = await createDm(page, bodyA, bodyB);
    await waitForWs(page);
    await waitForWs(pageB);
    await page.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(1500));
    await pageB.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(1500));

    await openDm(pageB);

    // A rings B → the callee's row shows the GREEN badge with the FAST ring pulse.
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: userB });
    await pageB.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-calling-dot`, { timeout: 15000 });
    const ringAnim = await pageB.evaluate((dmId) => {
        const el = document.querySelector(`.dm-item[data-dm-id="${dmId}"] .dm-calling-dot`) as HTMLElement;
        const cs = getComputedStyle(el);
        return { name: cs.animationName, dur: cs.animationDuration };
    }, dm.id);
    console.log('[PULSE] ring badge animation:', JSON.stringify(ringAnim));
    expect(ringAnim.name).toBe('dm-ring-pulse');
    // Fast: 0.55s — strictly faster than the calm 1.8s waiting pulse.
    const durMs = parseFloat(ringAnim.dur);
    expect(durMs).toBeGreaterThan(0);
    expect(durMs).toBeLessThan(1);

    // The ring times out → the SAME row drops to the red waiting-for-us badge,
    // green gone, and the red uses the CALM pulse (clearly slower than green).
    await pageB.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-for-us-dot`, { timeout: 15000 });
    expect(await pageB.locator(`.dm-item[data-dm-id="${dm.id}"] .dm-calling-dot`).count()).toBe(0);
    const waitAnim = await pageB.evaluate((dmId) => {
        const el = document.querySelector(`.dm-item[data-dm-id="${dmId}"] .dm-for-us-dot`) as HTMLElement;
        const cs = getComputedStyle(el);
        return { name: cs.animationName, dur: cs.animationDuration };
    }, dm.id);
    console.log('[PULSE] waiting badge animation:', JSON.stringify(waitAnim));
    expect(waitAnim.name).toBe('dm-badge-pulse');
    const waitMs = parseFloat(waitAnim.dur);
    expect(waitMs).toBeGreaterThan(1); // calm, visibly slower than the 0.55s ring
});

test('ring haptic repeats per ringtone cycle and stops at the ring→waiting flip; the Settings → Voice toggles disable it', async ({ page, context }) => {
    test.setTimeout(120000);
    const ts = Date.now();
    const userA = 'hpc1_' + ts;
    const userB = 'hpc2_' + ts;
    const ctxB = await context.browser()!.newContext();
    const pageB = await ctxB.newPage();
    // Stub the Vibration API so headless can count cues AND record every
    // pattern. Ring cues ([150,80,150]) and the waiting cue ([60,40,60]) are
    // distinguished by pattern, so timing races can't make this flaky.
    await pageB.addInitScript(() => {
        (navigator as any).vibrate = (pattern: any) => {
            (window as any).__vibrateCalls = ((window as any).__vibrateCalls || 0) + 1;
            (window as any).__vibratePattern = pattern;
            (window as any).__vibrateHistory = ((window as any).__vibrateHistory || []).concat([pattern]);
            return true;
        };
    });
    const bodyB = await registerUser(pageB, userB);
    const bodyA = await registerUser(page, userA);
    await setupFriends(page, pageB, bodyA, bodyB);
    const { userData, dm } = await createDm(page, bodyA, bodyB);
    await waitForWs(page);
    await waitForWs(pageB);
    // Long ring so the REPEAT behavior is observable before the timeout flips it.
    await page.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(4000));
    await pageB.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(4000));

    await openDm(pageB);

    // A rings B → the NEW-ring cue fires FIRST with the ring-like pattern.
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: userB });
    await pageB.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-calling-dot`, { timeout: 15000 });
    await pageB.waitForFunction(() => (window as any).__vibrateCalls >= 1, undefined, { timeout: 5000 });
    const ringPattern = await pageB.evaluate(() => (window as any).__vibratePattern);
    console.log('[HAPTIC] first ring cue pattern:', JSON.stringify(ringPattern));
    expect(ringPattern).toEqual([150, 80, 150]); // distinct ring-like pattern

    // Prolonged unanswered ring keeps buzzing — one cue per ringtone cycle
    // (~1.1s). By ~3s there should be the immediate cue + at least 2 repeats,
    // and the latest pattern must STILL be the ring pattern (not the waiting
    // buzz), proving the ticker repeats rather than firing once.
    await pageB.waitForFunction(() => (window as any).__vibrateCalls >= 3, undefined, { timeout: 6000 });
    const ringCalls = await pageB.evaluate(() => (window as any).__vibrateCalls || 0);
    const ringPattern2 = await pageB.evaluate(() => (window as any).__vibratePattern);
    console.log('[HAPTIC] repeated ring cues:', ringCalls, 'pattern:', JSON.stringify(ringPattern2));
    expect(ringPattern2).toEqual([150, 80, 150]); // still the ring pattern → repeats
    expect(ringCalls).toBeGreaterThanOrEqual(3);

    // Ring times out → the waiting cue fires with the SHORT double-buzz.
    await pageB.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-for-us-dot`, { timeout: 15000 });
    await pageB.waitForFunction(() => {
        const h = (window as any).__vibrateHistory || [];
        return h.some((p: any) => Array.isArray(p) && p.length === 3 && p[0] === 60 && p[1] === 40 && p[2] === 60);
    }, undefined, { timeout: 5000 });
    const waitCalls = await pageB.evaluate(() => (window as any).__vibrateCalls || 0);
    const waitPattern = await pageB.evaluate(() => (window as any).__vibratePattern);
    console.log('[HAPTIC] ring→waiting fired at call #', waitCalls, 'pattern:', JSON.stringify(waitPattern));
    expect(waitPattern).toEqual([60, 40, 60]); // distinct from the ring pattern (uniform pulses)

    // The ring ticker STOPS at the flip: no further cues after it.
    await pageB.waitForTimeout(1500);
    expect(await pageB.evaluate(() => (window as any).__vibrateCalls || 0)).toBe(waitCalls);

    // Toggle the WAITING setting OFF → that helper must not vibrate.
    const beforeWait = await pageB.evaluate(() => (window as any).__vibrateCalls || 0);
    await pageB.evaluate(() => {
        (window as any).VoiceManager._debug.state.settings.hapticWaiting = false;
    });
    await pageB.evaluate(() => (window as any).VoiceManager.vibrateWaitingCue());
    expect(await pageB.evaluate(() => (window as any).__vibrateCalls || 0)).toBe(beforeWait); // unchanged
    await pageB.evaluate(() => {
        (window as any).VoiceManager._debug.state.settings.hapticWaiting = true;
    });
    await pageB.evaluate(() => (window as any).VoiceManager.vibrateWaitingCue());
    expect(await pageB.evaluate(() => (window as any).__vibrateCalls || 0)).toBe(beforeWait + 1);

    // Toggle the INCOMING setting OFF → that helper must not vibrate either.
    const beforeIn = await pageB.evaluate(() => (window as any).__vibrateCalls || 0);
    await pageB.evaluate(() => {
        (window as any).VoiceManager._debug.state.settings.hapticIncoming = false;
    });
    await pageB.evaluate(() => (window as any).VoiceManager.vibrateIncomingRingCue());
    expect(await pageB.evaluate(() => (window as any).__vibrateCalls || 0)).toBe(beforeIn); // unchanged
    await pageB.evaluate(() => {
        (window as any).VoiceManager._debug.state.settings.hapticIncoming = true;
    });
    await pageB.evaluate(() => (window as any).VoiceManager.vibrateIncomingRingCue());
    expect(await pageB.evaluate(() => (window as any).__vibrateCalls || 0)).toBe(beforeIn + 1);
    console.log('[HAPTIC] both toggles respected');
});

test('haptic patterns are tunable via Settings → Voice sliders, persist, and the Test buttons bypass the toggles', async ({ page }) => {
    test.setTimeout(120000);
    const ts = Date.now();
    const user = 'hpt_' + ts;
    await page.addInitScript(() => {
        (navigator as any).vibrate = (pattern: any) => {
            (window as any).__vibrateCalls = ((window as any).__vibrateCalls || 0) + 1;
            (window as any).__vibratePattern = pattern;
            return true;
        };
    });
    await registerUser(page, user);
    await waitForWs(page);

    // Tune the ring pattern through the REAL sliders (input events) —
    // pulse 250ms, gap 100ms, 3 pulses → [250, 100, 250, 100, 250].
    await page.evaluate(() => {
        const setRange = (id: string, v: number) => {
            const el = document.getElementById(id) as HTMLInputElement;
            el.value = String(v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setRange('voice-haptic-ring-pulse', 250);
        setRange('voice-haptic-ring-gap', 100);
        setRange('voice-haptic-ring-pulses', 3);
    });

    // The cue now uses the tuned pattern…
    await page.evaluate(() => (window as any).VoiceManager.vibrateIncomingRingCue());
    expect(await page.evaluate(() => (window as any).__vibratePattern)).toEqual([250, 100, 250, 100, 250]);

    // …the value labels updated…
    expect(await page.evaluate(() => document.getElementById('voice-haptic-ring-pulse-val')!.textContent)).toBe('250ms');
    expect(await page.evaluate(() => document.getElementById('voice-haptic-ring-pulses-val')!.textContent)).toBe('3×');

    // …and it persisted to voice_settings.
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('voice_settings') || '{}'));
    expect(stored.hapticRingPattern).toEqual({ pulse: 250, gap: 100, pulses: 3 });

    // The waiting cue is independent — still its own default.
    await page.evaluate(() => (window as any).VoiceManager.vibrateWaitingCue());
    expect(await page.evaluate(() => (window as any).__vibratePattern)).toEqual([60, 40, 60]);

    // Test button bypasses the enable toggles: ring cue disabled → the
    // "Test pattern" button still buzzes with the tuned pattern.
    await page.evaluate(() => { (window as any).VoiceManager._debug.state.settings.hapticIncoming = false; });
    // The settings modal is hidden — dispatch the click directly (the handler
    // is bound at startup regardless of modal visibility).
    await page.evaluate(() => (document.getElementById('voice-haptic-ring-test') as HTMLButtonElement).click());
    expect(await page.evaluate(() => (window as any).__vibratePattern)).toEqual([250, 100, 250, 100, 250]);

    // A page reload restores the tuned pattern (persisted, not hardcoded).
    await page.reload();
    await page.waitForFunction(() => !!(window as any).VoiceManager, undefined, { timeout: 15000 });
    const restored = await page.evaluate(() => {
        const vm = (window as any).VoiceManager;
        return { pulse: vm.getHapticPattern('ring').pulse, gap: vm.getHapticPattern('ring').gap, pulses: vm.getHapticPattern('ring').pulses };
    });
    expect(restored).toEqual({ pulse: 250, gap: 100, pulses: 3 });
    console.log('[HAPTIC] tuned patterns: persist, apply to cues, survive reload');
});

test('new DM message fires the configurable notifDm haptic on the receiver; tuning + toggle apply', async ({ page, context }) => {
    test.setTimeout(120000);
    const ts = Date.now();
    const userA = 'hdm1_' + ts;
    const userB = 'hdm2_' + ts;
    const ctxB = await context.browser()!.newContext();
    const pageB = await ctxB.newPage();
    // Stub the Vibration API on the RECEIVER so headless can count cues.
    await pageB.addInitScript(() => {
        (navigator as any).vibrate = (pattern: any) => {
            (window as any).__vibrateCalls = ((window as any).__vibrateCalls || 0) + 1;
            (window as any).__vibratePattern = pattern;
            (window as any).__vibrateHistory = ((window as any).__vibrateHistory || []).concat([pattern]);
            return true;
        };
    });
    const bodyB = await registerUser(pageB, userB);
    const bodyA = await registerUser(page, userA);
    await setupFriends(page, pageB, bodyA, bodyB);
    const { userData, dm } = await createDm(page, bodyA, bodyB);
    await waitForWs(page);
    await waitForWs(pageB);
    // The friend-accept auto-selects the new DM on BOTH pages. Step B out of
    // that conversation (enterDmView clears currentDmChannelId) so incoming DM
    // messages take the notification path, not the append-to-open path.
    await pageB.evaluate(() => (window as any).enterDmView());
    await openDm(page);

    // 1. Send a message from A → B vibrates with the DEFAULT notifDm pattern.
    await page.fill('#message-input', 'hello ' + ts);
    await page.press('#message-input', 'Enter');
    await pageB.waitForFunction(() => {
        const h = (window as any).__vibrateHistory || [];
        return h.some((p: any) => Array.isArray(p) && p.join(',') === '80,60,80');
    }, undefined, { timeout: 15000 });
    const dmPattern = await pageB.evaluate(() => (window as any).__vibratePattern);
    console.log('[HAPTIC-DM] default pattern:', JSON.stringify(dmPattern));
    expect(dmPattern).toEqual([80, 60, 80]);

    // 2. Tune the notifDm pattern via the REAL sliders → next message uses it.
    await pageB.evaluate(() => {
        const setRange = (id: string, v: number) => {
            const el = document.getElementById(id) as HTMLInputElement;
            el.value = String(v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setRange('notif-haptic-dm-pulse', 200);
        setRange('notif-haptic-dm-gap', 120);
        setRange('notif-haptic-dm-pulses', 3);
    });
    await page.fill('#message-input', 'tuned ' + ts);
    await page.press('#message-input', 'Enter');
    await pageB.waitForFunction(() => {
        const h = (window as any).__vibrateHistory || [];
        return h.some((p: any) => Array.isArray(p) && p.join(',') === '200,120,200,120,200');
    }, undefined, { timeout: 15000 });
    const tunedPattern = await pageB.evaluate(() => (window as any).__vibratePattern);
    console.log('[HAPTIC-DM] tuned pattern:', JSON.stringify(tunedPattern));
    expect(tunedPattern).toEqual([200, 120, 200, 120, 200]);
    const storedDm = await pageB.evaluate(() => JSON.parse(localStorage.getItem('voice_settings') || '{}'));
    expect(storedDm.hapticNotifDmPattern).toEqual({ pulse: 200, gap: 120, pulses: 3 });

    // 3. Disable the toggle → further messages must NOT vibrate.
    const before = await pageB.evaluate(() => (window as any).__vibrateCalls || 0);
    await pageB.evaluate(() => (window as any).VoiceManager.setHapticSetting('hapticNotifDm', false));
    await page.fill('#message-input', 'muted ' + ts);
    await page.press('#message-input', 'Enter');
    await pageB.waitForTimeout(2500);
    expect(await pageB.evaluate(() => (window as any).__vibrateCalls || 0)).toBe(before);
    console.log('[HAPTIC-DM] toggle respected');
});

test('notification-box haptic: mentions fire the configurable notifInbox pattern; tuning, toggle, test button', async ({ page }) => {
    test.setTimeout(120000);
    const ts = Date.now();
    const user = 'hin_' + ts;
    await page.addInitScript(() => {
        (navigator as any).vibrate = (pattern: any) => {
            (window as any).__vibrateCalls = ((window as any).__vibrateCalls || 0) + 1;
            (window as any).__vibratePattern = pattern;
            (window as any).__vibrateHistory = ((window as any).__vibrateHistory || []).concat([pattern]);
            return true;
        };
    });
    await registerUser(page, user);
    await waitForWs(page);

    // Simulate a mention landing in the notification box — the exact call the
    // mention/reply WS handler makes. Real IDs aren't needed: nothing here is
    // muted and the haptic fires after the inbox item is added.
    const fireMention = () => page.evaluate(() => {
        (window as any).trackUnreadMention('srv-' + Date.now(), 'ch-' + Date.now(), null, 'msg-' + Date.now(), 'Sender', 'general', 'My Server', 'mention', 'u-' + Date.now(), null);
    });

    // 1. Default notifInbox pattern.
    await fireMention();
    await page.waitForFunction(() => {
        const h = (window as any).__vibrateHistory || [];
        return h.some((p: any) => Array.isArray(p) && p.join(',') === '120,90,120');
    }, undefined, { timeout: 10000 });
    expect(await page.evaluate(() => (window as any).__vibratePattern)).toEqual([120, 90, 120]);

    // 2. Tune via the sliders → next mention uses the tuned pattern.
    await page.evaluate(() => {
        const setRange = (id: string, v: number) => {
            const el = document.getElementById(id) as HTMLInputElement;
            el.value = String(v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setRange('notif-haptic-inbox-pulse', 250);
        setRange('notif-haptic-inbox-gap', 100);
        setRange('notif-haptic-inbox-pulses', 3);
    });
    await fireMention();
    await page.waitForFunction(() => {
        const h = (window as any).__vibrateHistory || [];
        return h.some((p: any) => Array.isArray(p) && p.join(',') === '250,100,250,100,250');
    }, undefined, { timeout: 10000 });
    expect(await page.evaluate(() => (window as any).__vibratePattern)).toEqual([250, 100, 250, 100, 250]);
    const storedInbox = await page.evaluate(() => JSON.parse(localStorage.getItem('voice_settings') || '{}'));
    expect(storedInbox.hapticNotifInboxPattern).toEqual({ pulse: 250, gap: 100, pulses: 3 });
    expect(await page.evaluate(() => document.getElementById('notif-haptic-inbox-pulse-val')!.textContent)).toBe('250ms');

    // 3. Toggle off → mentions no longer vibrate…
    const before = await page.evaluate(() => (window as any).__vibrateCalls || 0);
    await page.evaluate(() => (window as any).VoiceManager.setHapticSetting('hapticNotifInbox', false));
    await fireMention();
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as any).__vibrateCalls || 0)).toBe(before);

    // 4. …but the Test button still buzzes (bypasses the toggle).
    await page.evaluate(() => (document.getElementById('notif-haptic-inbox-test') as HTMLButtonElement).click());
    expect(await page.evaluate(() => (window as any).__vibratePattern)).toEqual([250, 100, 250, 100, 250]);
    console.log('[HAPTIC-INBOX] default, tuned, toggle-off, and test-button all correct');
});

