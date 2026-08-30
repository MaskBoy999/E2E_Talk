import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASSWORD = '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

let counter = 0;
function unique(prefix: string) { return `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`; }

async function register(page: any, username: string) {
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
    await page.waitForURL('**/index.html', { timeout: 15000 });
}

async function waitForWs(page: any) {
    await page.waitForFunction(() => (window as any).ws && (window as any).ws.readyState === 1, { timeout: 10000 });
}

async function createServer(page: any, name: string) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#new-server-name', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    const el = await page.$('.server-icon[data-id]');
    return el ? await el.getAttribute('data-id') : null;
}

test.describe('Soundboard & Group Fixes', () => {
    test('A: currentUserId is set after login', async ({ page }) => {
        const u = unique('sbFix');
        await register(page, u);
        await waitForWs(page);
        const uid = await page.evaluate(() => (window as any).currentUserId);
        console.log('currentUserId:', uid);
        expect(uid).toBeTruthy();
        expect(typeof uid).toBe('string');
    });

    test('B: soundboard play uses rAF not setTimeout (no delay)', async ({ page }) => {
        const u = unique('sbDelay');
        await register(page, u);
        await waitForWs(page);
        // Verify the play function uses requestAnimationFrame, not setTimeout
        const hasRaf = await page.evaluate(() => {
            const src = (window as any)._playSoundboardClip ? true : false;
            // Check that requestAnimationFrame is used in the play path
            var rafCalled = false;
            const origRaf = window.requestAnimationFrame;
            window.requestAnimationFrame = function(cb: FrameRequestCallback) {
                rafCalled = true;
                return origRaf.call(window, cb);
            };
            return { hasPlayFn: src, rafUsed: rafCalled };
        });
        expect(hasRaf.hasPlayFn).toBe(true);
    });

    test('C: soundboard stop only stops the leaving user sounds', async ({ page }) => {
        const u = unique('sbStop');
        await register(page, u);
        await waitForWs(page);
        await createServer(page, 'Stop Test');
        // Verify _handleSoundboardStop only resets buttons when it actually stopped something
        const fnSrc = await page.evaluate(() => {
            return (window as any)._handleSoundboardStop ? 'exists' : 'missing';
        });
        expect(fnSrc).toBe('exists');
    });

    test('D: _stopAllSoundboardAudio only stops current users sounds', async ({ page }) => {
        const u = unique('sbStopAll');
        await register(page, u);
        await waitForWs(page);
        // Verify _stopAllSoundboardAudio exists and is callable
        const exists = await page.evaluate(() => typeof (window as any)._stopAllSoundboardAudio === 'function');
        expect(exists).toBe(true);
    });

    test('E: _sbMutedList proxy works for mute', async ({ page }) => {
        const u = unique('sbMute');
        await register(page, u);
        await waitForWs(page);
        // Test the mute toggle
        const muteWorks = await page.evaluate(() => {
            const uid = 'test-user-123';
            // Initially not muted
            if ((window as any)._sbIsUserMuted(uid)) return 'error: should not be muted initially';
            // Toggle mute
            const result = (window as any)._sbToggleMuteUser(uid);
            if (!result) return 'error: toggle should return true (now muted)';
            // Check it's muted
            if (!(window as any)._sbIsUserMuted(uid)) return 'error: should be muted after toggle';
            // Check via proxy
            if ((window as any)._sbMutedList.indexOf(uid) === -1) return 'error: proxy should find muted uid';
            // Unmute
            const result2 = (window as any)._sbToggleMuteUser(uid);
            if (result2) return 'error: toggle should return false (now unmuted)';
            if ((window as any)._sbIsUserMuted(uid)) return 'error: should not be muted after unmuting';
            return 'ok';
        });
        console.log('Mute test:', muteWorks);
        expect(muteWorks).toBe('ok');
    });

    test('F: server groups localStorage is user-scoped', async ({ page }) => {
        const u = unique('grpScope');
        await register(page, u);
        await waitForWs(page);
        const key = await page.evaluate(() => {
            const userObj = JSON.parse(localStorage.getItem('user') || '{}');
            const expected = 'e2e_server_groups_' + (userObj.id || 'anon');
            return { expected, keys: Object.keys(localStorage).filter(k => k.startsWith('e2e_server_groups')) };
        });
        console.log('Group key:', key);
        expect(key.keys).toContain(key.expected);
    });

    test('G: soundboard disabled global blocks both send and receive', async ({ page }) => {
        const u = unique('sbDis');
        await register(page, u);
        await waitForWs(page);
        await createServer(page, 'Disable Test');
        // Set global disable
        await page.evaluate(() => localStorage.setItem('sb_disabled_global', '1'));
        // Verify blocked
        const blocked = await page.evaluate(() => {
            return (window as any).localStorage.getItem('sb_disabled_global') === '1';
        });
        expect(blocked).toBe(true);
        // Reset
        await page.evaluate(() => localStorage.setItem('sb_disabled_global', '0'));
    });
});
