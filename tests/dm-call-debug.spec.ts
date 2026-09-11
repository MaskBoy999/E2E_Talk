import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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

async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
    const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
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

test.describe('DM call layout debug', () => {
    test('measure and screenshot DM call panel', async ({ browser }) => {
        test.setTimeout(120000);
        const ts = Date.now();

        const ctx1 = await browser.newContext({ viewport: { width: 827, height: 800 } });
        const page = await ctx1.newPage();
        const ctx2 = await browser.newContext({ viewport: { width: 827, height: 800 } });
        const page2 = await ctx2.newPage();

        const u1 = await registerUser(page, 'dbg1_' + ts);
        const u2 = await registerUser(page2, 'dbg2_' + ts);
        await becomeFriends(page, page2, u1.token, u2.token);
        await waitForWs(page);
        await waitForWs(page2);

        // Open DM and start call
        await page.click('#dm-strip-btn');
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        await page.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 10000 });
        await page.click('.dm-call-btns .dm-call-btn');
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // page2 accepts
        await page2.waitForFunction(() => window.VoiceManager?._debug?.state?.incomingCall !== null, undefined, { timeout: 20000 });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 15000 });
        await page2.click('#incoming-call-accept');
        await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });
        await page.waitForFunction(() => window.VoiceManager?.isConnected() && window.VoiceManager?.isInDmCall(), undefined, { timeout: 15000 });

        // MEASURE everything
        const debug = await page.evaluate(() => {
            const panel = document.getElementById('dm-call-panel');
            const header = panel?.querySelector('.dm-call-header');
            const title = panel?.querySelector('.dm-call-header-title');
            const right = panel?.querySelector('.dm-call-header-right');
            const goto = panel?.querySelector('#dm-call-goto');

            const rect = (el: Element | null) => el ? el.getBoundingClientRect() : null;
            const mic = panel?.querySelector('#dm-call-mute');
            const micRect = rect(mic);
            const styles = (el: Element | null) => {
                if (!el) return null;
                const s = getComputedStyle(el);
                return {
                    display: s.display,
                    flexDirection: s.flexDirection,
                    justifyContent: s.justifyContent,
                    alignItems: s.alignItems,
                    width: s.width,
                    minWidth: s.minWidth,
                    maxWidth: s.maxWidth,
                    padding: s.padding,
                    gap: s.gap,
                    flex: s.flex,
                    flexGrow: s.flexGrow,
                    flexShrink: s.flexShrink,
                    flexBasis: s.flexBasis,
                    marginLeft: s.marginLeft,
                    marginRight: s.marginRight,
                    position: s.position,
                    left: s.left,
                    right: s.right,
                };
            };

            return {
                panelRect: rect(panel),
                panelStyles: styles(panel),
                headerRect: rect(header),
                headerStyles: styles(header),
                titleRect: rect(title),
                titleStyles: styles(title),
                rightRect: rect(right),
                rightStyles: styles(right),
                gotoRect: rect(goto),
                gotoStyles: styles(goto),
                micRect: micRect,
                viewportWidth: window.innerWidth,
                headerPadRight: header ? getComputedStyle(header).paddingRight : null,
            };
        });

        console.log('=== DM CALL PANEL DEBUG ===');
        console.log('Viewport:', debug.viewportWidth);
        console.log('Panel:', JSON.stringify(debug.panelRect, null, 2));
        console.log('Panel styles:', JSON.stringify(debug.panelStyles, null, 2));
        console.log('Header:', JSON.stringify(debug.headerRect, null, 2));
        console.log('Header styles:', JSON.stringify(debug.headerStyles, null, 2));
        console.log('Title:', JSON.stringify(debug.titleRect, null, 2));
        console.log('Right:', JSON.stringify(debug.rightRect, null, 2));
        console.log('Goto btn:', JSON.stringify(debug.gotoRect, null, 2));
        console.log('Mic btn:', JSON.stringify(debug.micRect, null, 2));
        console.log('Header padding-right:', debug.headerPadRight);
        console.log('=== END DEBUG ===');

        // Full page screenshot
        await page.screenshot({ path: 'tests/screenshots/debug-dm-call-full.png', fullPage: false });

        // Cropped header screenshot
        if (debug.headerRect) {
            await page.screenshot({
                path: 'tests/screenshots/debug-dm-call-header.png',
                clip: {
                    x: debug.panelRect!.x,
                    y: debug.panelRect!.y,
                    width: debug.panelRect!.width,
                    height: debug.headerRect.height + 20,
                },
            });
        }
    });
});
