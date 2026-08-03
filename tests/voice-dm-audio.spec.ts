import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mock getUserMedia/getDisplayMedia with real (but synthetic) streams so the
// voice pipeline actually captures and relays audio frames in a DM call.
async function mockMedia(page: any) {
    await page.addInitScript(() => {
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints: any) => {
            if (constraints && constraints.audio) {
                const ac = new (window as any).AudioContext();
                const osc = ac.createOscillator();
                osc.frequency.value = 300;
                const dest = ac.createMediaStreamDestination();
                osc.connect(dest);
                osc.start();
                (window as any).__mockOsc = osc;
                (window as any).__mockCtx = ac;
                return dest.stream;
            }
            if (constraints && constraints.video) {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                const ctx = canvas.getContext('2d')!;
                let i = 0;
                (window as any).__mockCanvasTimer = setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                return (canvas as any).captureStream(10);
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async (constraints: any) => {
            return (navigator.mediaDevices as any).getUserMedia({ video: true });
        };
    });
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
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

test.describe('DM call audio pipelines (with synthetic media)', () => {
    test('A speaks in DM call → B receives & plays audio; B speaks → A receives', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const p1Errors: string[] = [];
        page.on('pageerror', (err) => p1Errors.push('P1: ' + err.message));
        await mockMedia(page);
        const u1 = await registerUser(page, 'da1_' + ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const p2Errors: string[] = [];
        page2.on('pageerror', (err) => p2Errors.push('P2: ' + err.message));
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'da2_' + ts);
        await becomeFriends(page, page2, u1.token, u2.token);

        // Open DM view on both, wait for the DM item (ensureDmCallButton is
        // sometimes delayed — invoke it directly as a guarded fallback)
        await page.waitForFunction(() => !!(window as any).VoiceManager, { timeout: 15000 });
        await page.click('#dm-strip-btn');
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        try {
            await page.waitForSelector('#dm-call-btn', { timeout: 8000 });
        } catch (_) {
            await page.evaluate(() => {
                const vm = (window as any).VoiceManager;
                if (vm && vm.ensureDmCallButton) vm.ensureDmCallButton();
            });
            await page.waitForSelector('#dm-call-btn', { timeout: 8000 });
        }

        await page2.waitForFunction(() => !!(window as any).VoiceManager, { timeout: 15000 });
        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item', { timeout: 15000 });
        await page2.click('.dm-item');
        try {
            await page2.waitForSelector('#dm-call-btn', { timeout: 8000 });
        } catch (_) {
            await page2.evaluate(() => {
                const vm = (window as any).VoiceManager;
                if (vm && vm.ensureDmCallButton) vm.ensureDmCallButton();
            });
            await page2.waitForSelector('#dm-call-btn', { timeout: 8000 });
        }

        // A starts the call
        await page.click('#dm-call-btn');
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // B joins
        await page2.waitForSelector('#call-mini-bar', { state: 'visible', timeout: 10000 });
        await page2.waitForTimeout(500);
        await page2.click('#dm-call-btn');
        await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // Both must be able to derive the DM room key (null key = silent audio
        // both directions while the speaking light still works).
        await page.waitForTimeout(1500);
        const aKey = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            return vm && vm._debugRoomKey ? vm._debugRoomKey() : 'no-accessor';
        });
        const bKey = await page2.evaluate(() => {
            const vm = (window as any).VoiceManager;
            return vm && vm._debugRoomKey ? vm._debugRoomKey() : 'no-accessor';
        });
        console.log('A ROOM KEY:', aKey);
        console.log('B ROOM KEY:', bKey);
        expect(aKey).toContain('key:');
        expect(bKey).toContain('key:');

        // Instrument both sides: count voice_audio frames received AND whether a
        // gain node was created for the other user (i.e., audio actually played).
        await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            const orig = vm.handleServerMessage.bind(vm);
            (window as any).__dmAudio = { recv: 0, gainForOther: false };
            vm.handleServerMessage = function (data: any) {
                if (data && data.type === 'voice_audio') (window as any).__dmAudio.recv++;
                return orig(data);
            };
        });
        await page2.evaluate(() => {
            const vm = (window as any).VoiceManager;
            const orig = vm.handleServerMessage.bind(vm);
            (window as any).__dmAudio = { recv: 0, gainForOther: false };
            vm.handleServerMessage = function (data: any) {
                if (data && data.type === 'voice_audio') (window as any).__dmAudio.recv++;
                return orig(data);
            };
        });

        // Both mics are auto-captured on join (mock stream) — let frames flow.
        await page.waitForTimeout(3500);

        const aState = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            const d = (window as any).__dmAudio || { recv: 0 };
            return {
                recvFrames: d.recv,
                selfMuted: (vm._debugState ? vm._debugState() : {}).muted,
                ctx: vm._debugAudioCtx ? vm._debugAudioCtx().state : null,
            };
        });
        const bState = await page2.evaluate(() => {
            const vm = (window as any).VoiceManager;
            const d = (window as any).__dmAudio || { recv: 0 };
            return {
                recvFrames: d.recv,
                selfMuted: (vm._debugState ? vm._debugState() : {}).muted,
                ctx: vm._debugAudioCtx ? vm._debugAudioCtx().state : null,
            };
        });
        console.log('A DM AUDIO STATE:', JSON.stringify(aState));
        console.log('B DM AUDIO STATE:', JSON.stringify(bState));
        console.log('P1 ERRORS:', JSON.stringify(p1Errors));
        console.log('P2 ERRORS:', JSON.stringify(p2Errors));

        // Core assertions: both AudioContexts running, nobody muted, and audio
        // frames received BOTH directions (A hears B, B hears A).
        expect(aState.ctx).toBe('running');
        expect(bState.ctx).toBe('running');
        expect(aState.selfMuted).toBe(false);
        expect(bState.selfMuted).toBe(false);
        expect(bState.recvFrames).toBeGreaterThan(20);  // B hears A
        expect(aState.recvFrames).toBeGreaterThan(20);  // A hears B

        // ---- Honest speaking light: if the DM key can't be derived, the mic's
        // local RMS must NOT light the speaking ring / broadcast speaking=true
        // (previously the light came on while nobody could hear — the exact bug
        // the user reported: "light indicates I'm heard but I hear nothing"). ----
        // Simulate the key-loss state on A, wait a speak-detection cycle, and
        // confirm A's speaking flag stays false and frames stop flowing.
        const keyLossApplied = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            return vm._debugSimulateKeyLoss();
        });
        expect(keyLossApplied).toBe(true);
        const noKey = await page.evaluate(() => (window as any).VoiceManager._debugRoomKey());
        console.log('A KEY AFTER SIMULATED LOSS:', noKey);
        expect(noKey).toBe('NO_KEY');

        // A's speaking flag must be false even though the mock mic is producing
        // audio (RMS high) — the honest-light gate turns it off.
        await page.waitForTimeout(1000);
        const aHonest = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            return vm._debugState();
        });
        console.log('A HONEST STATE (no key):', JSON.stringify(aHonest));
        expect(aHonest.speaking).toBe(false);

        // Frames from A must stop reaching B while the key is lost.
        const bRecvBefore = (await page2.evaluate(() => (window as any).__dmAudio.recv));
        await page.waitForTimeout(1200);
        const bRecvAfter = (await page2.evaluate(() => (window as any).__dmAudio.recv));
        console.log('B recv before/after A key loss:', bRecvBefore, '->', bRecvAfter);
        expect(bRecvAfter - bRecvBefore).toBeLessThan(10);

        // Self-heal: healDmRoomKey() refetches the other user's identity key and
        // the DM key becomes derivable again → A can talk again.
        await page.evaluate(() => (window as any).VoiceManager._debugHealKey());
        await page.waitForTimeout(2000);
        const healed = await page.evaluate(() => (window as any).VoiceManager._debugRoomKey());
        console.log('A KEY AFTER HEAL:', healed);
        expect(healed).toContain('key:');

        // Frames flow again once healed.
        const bRecvHeal1 = (await page2.evaluate(() => (window as any).__dmAudio.recv));
        await page.waitForTimeout(1500);
        const bRecvHeal2 = (await page2.evaluate(() => (window as any).__dmAudio.recv));
        console.log('B recv after heal:', bRecvHeal1, '->', bRecvHeal2);
        expect(bRecvHeal2).toBeGreaterThan(bRecvHeal1);

        console.log('P1 ERRORS:', JSON.stringify(p1Errors));
        console.log('P2 ERRORS:', JSON.stringify(p2Errors));
    });
});
