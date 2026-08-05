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

async function createServerWithChannels(page: any, ts: number, channelTypes: string[]) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'UI_' + ts);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id'));
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const channels: any[] = [];
    for (let i = 0; i < channelTypes.length; i++) {
        const encName = await page.evaluate(async (name) => {
            const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')));
            return E2ECrypto.aeadEncrypt(name, new Uint8Array(k));
        }, 'ch' + i);
        const res = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { encrypted_name: encName.ciphertext, name_nonce: encName.nonce, channel_type: channelTypes[i] },
        });
        expect(res.ok()).toBeTruthy();
        channels.push(await res.json());
    }
    return { serverId, token, channels };
}

test.describe('voice UI bug fixes', () => {
    test('bar buttons work (no double-toggle), no duplicate self video, popup closes on channel switch, self video persists', async ({ page }) => {
        const ts = Date.now();
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await mockMedia(page);
        await registerUser(page, 'ui1_' + ts);
        const srv = await createServerWithChannels(page, ts, ['voice', 'text']);

        // join voice channel → floating bar appears
        await page.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${srv.channels[0].id}"]`, { timeout: 10000 });
        await page.click(`.channel-item[data-id="${srv.channels[0].id}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });
        await page.waitForTimeout(1500);

        // 1) BAR BUTTONS: mute must toggle exactly once per click (double-init
        // previously bound two listeners → click = mute+unmute = net no change).
        const muteBtn = page.locator('#voice-bar-mute');
        await muteBtn.click();
        await page.waitForTimeout(300);
        const mutedAfterClick = await page.evaluate(() => {
            return document.getElementById('voice-bar-mute')!.classList.contains('active');
        });
        expect(mutedAfterClick).toBe(true);
        await muteBtn.click();
        await page.waitForTimeout(300);
        const mutedAfterSecond = await page.evaluate(() => {
            return document.getElementById('voice-bar-mute')!.classList.contains('active');
        });
        expect(mutedAfterSecond).toBe(false);

        // 2) POPUP: open it, start camera, the self member row must show the
        // camera <video> tile (data-self="1") with no duplicates.
        await page.click(`.channel-item[data-id="${srv.channels[0].id}"]`); // second click → popup
        await page.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });
        await page.click('#voice-popup-camera');
        await page.waitForTimeout(2000);
        const selfRowState = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('#voice-popup-members .voice-member-row'));
            const selfRow = rows.find((r: any) => r.getAttribute('data-self') === '1');
            if (!selfRow) return { found: false, videos: 0, cameraDisplay: null, screenDisplay: null };
            // Side-by-side design: each row has TWO <video> slots (camera +
            // screen); only the active one is displayed.
            const cam = selfRow.querySelector('video[data-kind="camera"]');
            const scr = selfRow.querySelector('video[data-kind="screen"]');
            return {
                found: true,
                videos: selfRow.querySelectorAll('video.remote-video-tile').length,
                cameraDisplay: cam ? (cam as any).style.display : null,
                screenDisplay: scr ? (scr as any).style.display : null,
            };
        });
        expect(selfRowState.found).toBe(true);
        expect(selfRowState.videos).toBe(2);
        expect(selfRowState.cameraDisplay).toBe('block');
        expect(selfRowState.screenDisplay).toBe('none');

        // 3) SELF VIDEO PERSISTS: tag the video element, trigger voice_state
        // churn (mute/deafen toggles broadcast state updates), and verify the
        // SAME element is still attached (re-rendering would recreate it).
        const videoIdBefore = await page.evaluate(() => {
            const v = document.querySelector('#voice-popup-members .voice-member-row[data-self="1"] video.remote-video-tile');
            if (!v) return null;
            (v as any).__debugId = 'VID' + Math.random();
            (window as any).__lastVideoId = (v as any).__debugId;
            return (v as any).__debugId;
        });
        expect(videoIdBefore).toBeTruthy();
        await page.click('#voice-popup-mute');
        await page.click('#voice-popup-deafen');
        await page.click('#voice-popup-deafen');
        await page.click('#voice-popup-mute');
        await page.waitForTimeout(1500);
        const videoPersists = await page.evaluate(() => {
            const v = document.querySelector('#voice-popup-members .voice-member-row[data-self="1"] video.remote-video-tile');
            return !!v && (v as any).__debugId === (window as any).__lastVideoId;
        });
        expect(videoPersists).toBe(true);

        // 4) CHANNEL SWITCH: switching to a text channel must close the popup
        // (previously it stayed open covering the new channel's messages).
        await page.click(`.channel-item[data-id="${srv.channels[1].id}"]`);
        await page.waitForTimeout(600);
        const popupDisplay = await page.evaluate(() => {
            const el = document.getElementById('voice-popup');
            return el ? getComputedStyle(el).display : 'missing';
        });
        expect(popupDisplay).toBe('none');
        // voice channel header shows the text channel now
        const headerText = await page.evaluate(() => document.getElementById('channel-name')!.textContent);
        expect(headerText).toContain('ch1');

        expect(errors).toEqual([]);
    });
});
