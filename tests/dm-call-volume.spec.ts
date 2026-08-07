import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= maxRetries) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
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

test.describe('DM call per-member volume slider', () => {
    test('right-clicking anywhere on the DM tile opens the 0-500% volume menu', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        await mockMedia(page);
        const u1 = await registerUser(page, 'vol1_' + ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'vol2_' + ts);

        await setupFriends(page, page2, u1, u2);
        const userData = await (await page.request.get(`${BASE}/api/user/${u2.user.username}`, {
            headers: { Authorization: `Bearer ${u1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${u1.token}` },
        })).json();
        expect(dm.id).toBeTruthy();

        await waitForWs(page);
        await waitForWs(page2);

        await page.click('#dm-strip-btn').catch(() => {});
        await page.waitForTimeout(800);
        await page.locator('.dm-item, .dm-conv, [data-dm-id]').first().click().catch(() => {});
        await page.waitForTimeout(800);

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: u2.user.username });

        await page2.waitForSelector('#incoming-call-accept:visible', { timeout: 20000 });
        await page2.click('#incoming-call-accept');
        await page.waitForTimeout(2500);

        // A right-clicks the partner's tile (the tile wrapper, not a video)
        await page.waitForSelector('.dm-call-tile', { timeout: 10000 });
        await page.click('.dm-call-tile', { button: 'right', position: { x: 10, y: 10 } });
        await page.waitForSelector('#volume-menu:visible', { timeout: 5000 });

        const menuState = await page.evaluate(() => {
            const menu = document.getElementById('volume-menu') as HTMLElement;
            const slider = menu?.querySelector('.volume-menu-slider') as HTMLInputElement;
            return {
                visible: !!menu && menu.style.display !== 'none',
                hasSlider: !!slider,
                min: slider ? slider.min : null,
                max: slider ? slider.max : null,
                value: slider ? slider.value : null,
                header: menu?.querySelector('.volume-menu-header')?.textContent || '',
            };
        });
        expect(menuState.visible).toBe(true);
        expect(menuState.hasSlider).toBe(true);
        expect(menuState.min).toBe('0');
        expect(menuState.max).toBe('500');
        expect(menuState.header).toBe(u2.user.username);

        // Adjusting the slider persists per-member and applies the gain
        await page.evaluate(() => {
            const slider = document.querySelector('.volume-menu-slider') as HTMLInputElement;
            slider.value = '250';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const stored = await page.evaluate((uid) => localStorage.getItem('voice_volume_' + uid), userData.id);
        expect(stored).toBe('250');
    });
});
