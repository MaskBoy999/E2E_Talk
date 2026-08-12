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

test('battery-friendly mode: repeats are skipped when low battery or backgrounded too long, resumable, and fully disableable; thresholds are customizable', async ({ page }) => {
    test.setTimeout(120000);
    const ts = Date.now();
    const user = 'hbat_' + ts;
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

    // Default state: battery friendly ON, threshold 20% / 10 min — battery at
    // 50% and app visible → repeats NOT suppressed.
    expect(await page.evaluate(() => (window as any).VoiceManager.hapticRepeatsSuppressed())).toBe(false);

    // Low battery (10% ≤ 20% threshold) → suppressed.
    await page.evaluate(() => (window as any).VoiceManager.setBatteryLevelForTest(10));
    expect(await page.evaluate(() => (window as any).VoiceManager.hapticRepeatsSuppressed())).toBe(true);

    // Healthy battery (30% > 20%) → not suppressed.
    await page.evaluate(() => (window as any).VoiceManager.setBatteryLevelForTest(30));
    expect(await page.evaluate(() => (window as any).VoiceManager.hapticRepeatsSuppressed())).toBe(false);

    // Threshold is customizable: raise it to 35% → 30% now counts as low.
    await page.evaluate(() => (window as any).VoiceManager.setHapticSetting('hapticBatteryThreshold', 35));
    await page.evaluate(() => (window as any).VoiceManager.setBatteryLevelForTest(30));
    expect(await page.evaluate(() => (window as any).VoiceManager.hapticRepeatsSuppressed())).toBe(true);

    // Backgrounded too long (15 min ≥ 10 min threshold) → suppressed even with
    // a healthy battery.
    await page.evaluate(() => {
        (window as any).VoiceManager.setBatteryLevelForTest(60);
        (window as any).VoiceManager.setBackgroundedMinutesForTest(15);
    });
    expect(await page.evaluate(() => (window as any).VoiceManager.hapticRepeatsSuppressed())).toBe(true);

    // Short backgrounding (5 min < 10) → not suppressed.
    await page.evaluate(() => (window as any).VoiceManager.setBackgroundedMinutesForTest(5));
    expect(await page.evaluate(() => (window as any).VoiceManager.hapticRepeatsSuppressed())).toBe(false);

    // Background threshold 0 → the background half is disabled entirely.
    await page.evaluate(() => {
        (window as any).VoiceManager.setHapticSetting('hapticBackgroundThreshold', 0);
        (window as any).VoiceManager.setBackgroundedMinutesForTest(120);
    });
    expect(await page.evaluate(() => (window as any).VoiceManager.hapticRepeatsSuppressed())).toBe(false);

    // The whole mode can be turned OFF completely — even 1% battery, nothing
    // is suppressed.
    await page.evaluate(() => {
        (window as any).VoiceManager.setBackgroundedMinutesForTest(0);
        (window as any).VoiceManager.setHapticSetting('hapticBatteryFriendly', false);
        (window as any).VoiceManager.setBatteryLevelForTest(1);
    });
    expect(await page.evaluate(() => (window as any).VoiceManager.hapticRepeatsSuppressed())).toBe(false);

    // TURN IT BACK ON for the ticker behavior test (threshold 20%).
    await page.evaluate(() => {
        (window as any).VoiceManager.setHapticSetting('hapticBatteryFriendly', true);
        (window as any).VoiceManager.setHapticSetting('hapticBatteryThreshold', 20);
    });

    // --- The ring ticker SKIPS repeats while low, fires the initial cue, and
    // RESUMES repeating when the battery recovers. Fake an incoming ring.
    await page.evaluate(() => {
        (window as any).VoiceManager._debug.state.incomingCall = { callerId: 'x', callerUsername: 'x', dmChannelId: 'bat-ch' };
    });
    await page.evaluate(() => (window as any).VoiceManager.setBatteryLevelForTest(5)); // low
    await page.evaluate(() => (window as any).VoiceManager.startRingHapticTicker());
    // Initial cue fires immediately (one-shot cues are NOT gated by battery mode).
    await page.waitForFunction(() => (window as any).__vibrateCalls >= 1, undefined, { timeout: 5000 });
    // …but ~3s of ticks (~3 ringtone cycles) add NO more cues.
    await page.waitForTimeout(3200);
    const lowCalls = await page.evaluate(() => (window as any).__vibrateCalls || 0);
    console.log('[BATTERY] cues while low:', lowCalls);
    expect(lowCalls).toBe(1);

    // Battery recovers → the NEXT tick buzzes again (repeats resume).
    await page.evaluate(() => (window as any).VoiceManager.setBatteryLevelForTest(80));
    await page.waitForFunction(() => (window as any).__vibrateCalls >= 2, undefined, { timeout: 5000 });
    const resumed = await page.evaluate(() => (window as any).__vibrateCalls || 0);
    expect(resumed).toBeGreaterThanOrEqual(2);
    console.log('[BATTERY] cues after recovery:', resumed);

    // Cleanup: stop the ticker (also stops the battery poll) and clear the fake ring.
    await page.evaluate(() => {
        (window as any).VoiceManager.stopRingHapticTicker();
        (window as any).VoiceManager._debug.state.incomingCall = null;
        (window as any).VoiceManager.setBackgroundedMinutesForTest(0);
    });
});

test('haptic Reset buttons restore each pattern to its default; labels, sliders, persisted settings and cues all revert', async ({ page }) => {
    test.setTimeout(120000);
    const ts = Date.now();
    const user = 'hrst_' + ts;
    await page.addInitScript(() => {
        (navigator as any).vibrate = (pattern: any) => {
            (window as any).__vibrateCalls = ((window as any).__vibrateCalls || 0) + 1;
            (window as any).__vibratePattern = pattern;
            return true;
        };
    });
    await registerUser(page, user);
    await waitForWs(page);

    // Tune the RING pattern away from its default (150/80/2 → 250/100/3).
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
    expect(await page.evaluate(() => (window as any).VoiceManager.getHapticPattern('ring'))).toEqual({ pulse: 250, gap: 100, pulses: 3 });

    // Click the Reset button → default restored in the pattern, labels, and
    // the persisted settings.
    await page.evaluate(() => (document.getElementById('voice-haptic-ring-reset') as HTMLButtonElement).click());
    expect(await page.evaluate(() => (window as any).VoiceManager.getHapticPattern('ring'))).toEqual({ pulse: 150, gap: 80, pulses: 2 });
    expect(await page.evaluate(() => document.getElementById('voice-haptic-ring-pulse-val')!.textContent)).toBe('150ms');
    expect(await page.evaluate(() => document.getElementById('voice-haptic-ring-pulses-val')!.textContent)).toBe('2×');
    expect(await page.evaluate(() => (document.getElementById('voice-haptic-ring-pulse') as HTMLInputElement).value)).toBe('150');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('voice_settings') || '{}'));
    expect(stored.hapticRingPattern).toEqual({ pulse: 150, gap: 80, pulses: 2 });

    // The cue itself uses the restored default.
    await page.evaluate(() => (window as any).VoiceManager.vibrateIncomingRingCue());
    expect(await page.evaluate(() => (window as any).__vibratePattern)).toEqual([150, 80, 150]);

    // The waiting pattern resets independently (60/40/2 default).
    await page.evaluate(() => {
        const el = document.getElementById('voice-haptic-waiting-pulse') as HTMLInputElement;
        el.value = '200';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await page.evaluate(() => (window as any).VoiceManager.getHapticPattern('waiting'))).toEqual({ pulse: 200, gap: 40, pulses: 2 });
    await page.evaluate(() => (document.getElementById('voice-haptic-waiting-reset') as HTMLButtonElement).click());
    expect(await page.evaluate(() => (window as any).VoiceManager.getHapticPattern('waiting'))).toEqual({ pulse: 60, gap: 40, pulses: 2 });

    // Notification patterns reset too.
    await page.evaluate(() => {
        const el = document.getElementById('notif-haptic-inbox-pulse') as HTMLInputElement;
        el.value = '400';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await page.evaluate(() => (window as any).VoiceManager.getHapticPattern('notifInbox'))).toEqual({ pulse: 400, gap: 90, pulses: 2 });
    await page.evaluate(() => (document.getElementById('notif-haptic-inbox-reset') as HTMLButtonElement).click());
    expect(await page.evaluate(() => (window as any).VoiceManager.getHapticPattern('notifInbox'))).toEqual({ pulse: 120, gap: 90, pulses: 2 });

    await page.evaluate(() => {
        const el = document.getElementById('notif-haptic-dm-pulse') as HTMLInputElement;
        el.value = '300';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => (document.getElementById('notif-haptic-dm-reset') as HTMLButtonElement).click());
    expect(await page.evaluate(() => (window as any).VoiceManager.getHapticPattern('notifDm'))).toEqual({ pulse: 80, gap: 60, pulses: 2 });
    console.log('[RESET] all four patterns reset to their defaults');
});

test('CALLER feels the waiting haptic when the callee DECLINES (not just on the 30s timeout)', async ({ page, context }) => {
    test.setTimeout(120000);
    const ts = Date.now();
    const userA = 'hdcl1_' + ts;
    const userB = 'hdcl2_' + ts;
    const ctxB = await context.browser()!.newContext();
    const pageB = await ctxB.newPage();
    // Stub the Vibration API on the CALLER (A) so we can count its cues.
    await page.addInitScript(() => {
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
    await page.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(15000)); // long ring — the decline must be what flips us
    await pageB.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(15000));
    await openDm(page);
    await openDm(pageB);

    // A calls B; B DECLINES immediately (well before any 30s timeout).
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: userB });
    await pageB.waitForFunction(() => !!(window as any).VoiceManager.getIncomingCall(), undefined, { timeout: 15000 });
    await pageB.evaluate(() => (window as any).VoiceManager.declineDmCall());

    // The CALLER must now be in the waiting state AND feel the waiting haptic
    // ([60,40,60]) — previously the decline path skipped the cue entirely.
    await page.waitForFunction(() => {
        const vm = (window as any).VoiceManager;
        return !!(vm.isCallWaiting && vm.isCallWaiting());
    }, undefined, { timeout: 15000 });
    await page.waitForFunction(() => {
        const h = (window as any).__vibrateHistory || [];
        return h.some((p: any) => Array.isArray(p) && p.join(',') === '60,40,60');
    }, undefined, { timeout: 10000 });
    const lastPattern = await page.evaluate(() => (window as any).__vibratePattern);
    console.log('[DECLINE] caller waiting cue pattern:', JSON.stringify(lastPattern));
    expect(lastPattern).toEqual([60, 40, 60]);
});

test('double stalemate: after decline → join → connect, neither side shows a phantom waiting marker (survives syncWaitingCalls)', async ({ page, context }) => {
    test.setTimeout(150000);
    const ts = Date.now();
    const userA = 'hds1_' + ts;
    const userB = 'hds2_' + ts;
    const ctxB = await context.browser()!.newContext();
    const pageB = await ctxB.newPage();
    const bodyB = await registerUser(pageB, userB);
    const bodyA = await registerUser(page, userA);
    await setupFriends(page, pageB, bodyA, bodyB);
    const { userData, dm } = await createDm(page, bodyA, bodyB);
    await waitForWs(page);
    await waitForWs(pageB);
    await page.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(15000));
    await pageB.evaluate(() => (window as any).VoiceManager.setRingTimeoutMs(15000));
    await openDm(page);
    await openDm(pageB);

    const getMarker = (p: any) => p.evaluate((dmId: string) => (window as any).VoiceManager.getWaitingCall(dmId), dm.id);
    const getConvWaiting = (p: any) => p.evaluate((dmId: string) => {
        const c = (window as any).dmConversations.find((x: any) => x.dm_channel_id === dmId);
        return c ? { uid: c.waiting_user_id, uname: c.waiting_username } : null;
    }, dm.id);

    // 1. A calls B → B declines → A amber, B red (both legitimately showing
    //    markers right now — A IS waiting).
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: userB });
    await pageB.waitForFunction(() => !!(window as any).VoiceManager.getIncomingCall(), undefined, { timeout: 15000 });
    await pageB.evaluate(() => (window as any).VoiceManager.declineDmCall());
    await page.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-waiting-dot`, { timeout: 15000 });
    await pageB.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-for-us-dot`, { timeout: 15000 });
    console.log('[STALE] decline: A amber, B red — correct');

    // 2. B joins from the waiting banner → the call CONNECTS. Both sides must
    //    drop the waiting marker in BOTH places (S.waitingCalls + the
    //    dmConversations fields syncWaitingCalls() rebuilds from).
    await pageB.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.joinWaitingCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: userA });
    await page.waitForFunction(() => !!(window as any).VoiceManager.isInDmCall && (window as any).VoiceManager.isInDmCall() && (window as any).VoiceManager._debug.state.dmCallAnswered, undefined, { timeout: 25000 });
    await pageB.waitForFunction(() => !!(window as any).VoiceManager.isInDmCall && (window as any).VoiceManager.isInDmCall() && (window as any).VoiceManager._debug.state.dmCallAnswered, undefined, { timeout: 25000 });

    // 3. The marker is gone on BOTH sides — from S.waitingCalls AND the cached
    //    conversation fields (the resurrection vector).
    expect(await getMarker(page)).toBeNull();
    expect(await getMarker(pageB)).toBeNull();
    const bConv = await getConvWaiting(pageB);
    const aConv = await getConvWaiting(page);
    console.log('[STALE] after connect — A conv:', JSON.stringify(aConv), 'B conv:', JSON.stringify(bConv));
    expect(aConv ? aConv.uid : null).toBeFalsy();
    expect(bConv ? bConv.uid : null).toBeFalsy();

    // 4. The killer scenario: syncWaitingCalls() (navigation/heartbeat) must
    //    NOT resurrect any phantom marker on either side.
    await page.evaluate(() => (window as any).VoiceManager.syncWaitingCalls());
    await pageB.evaluate(() => (window as any).VoiceManager.syncWaitingCalls());
    await page.waitForTimeout(600);
    expect(await getMarker(page)).toBeNull();
    expect(await getMarker(pageB)).toBeNull();
    // And the DM rows show the CONNECTED blue badge, not a waiting badge.
    const badgesA = await rowBadges(page, dm.id);
    const badgesB = await rowBadges(pageB, dm.id);
    console.log('[STALE] rows after sync — A:', JSON.stringify(badgesA), 'B:', JSON.stringify(badgesB));
    expect(badgesA).not.toContain('dm-waiting-dot');
    expect(badgesA).not.toContain('dm-for-us-dot');
    expect(badgesB).not.toContain('dm-waiting-dot');
    expect(badgesB).not.toContain('dm-for-us-dot');
    console.log('[STALE] connected call shows NO waiting indicators on either side');

    // 5. BOTH hang up → no phantom markers linger on either side after sync.
    await page.evaluate(() => (window as any).VoiceManager.endDmCall());
    await pageB.evaluate(() => (window as any).VoiceManager.endDmCall());
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window as any).VoiceManager.syncWaitingCalls());
    await pageB.evaluate(() => (window as any).VoiceManager.syncWaitingCalls());
    await page.waitForTimeout(600);
    expect(await getMarker(page)).toBeNull();
    expect(await getMarker(pageB)).toBeNull();
    const finalA = await rowBadges(page, dm.id);
    const finalB = await rowBadges(pageB, dm.id);
    console.log('[STALE] rows after both hang up — A:', JSON.stringify(finalA), 'B:', JSON.stringify(finalB));
    expect(finalA.filter((b: string) => b.includes('waiting') || b.includes('for-us'))).toEqual([]);
    expect(finalB.filter((b: string) => b.includes('waiting') || b.includes('for-us'))).toEqual([]);
});
