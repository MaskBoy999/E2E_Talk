import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASSWORD = 'testpass1234';
const SHOT = 'test-results/server-rail-scroll';

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

/**
 * Create `count` real servers directly through the API, using the app's own
 * crypto so each one has a valid encrypted name and a locally saved channel
 * key (exactly the state the UI create flow leaves behind).
 */
async function makeServers(page: Page, count: number): Promise<string[]> {
    return await page.evaluate(async (n) => {
        const E = (window as any).E2ECrypto;
        const token = localStorage.getItem('token');
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
            const key = E.generateSymmetricKey();
            const enc = E.aeadEncrypt('Rail' + i, key);
            const res = await fetch('/api/servers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({
                    name: 'Rail' + i,
                    encrypted_name: enc.ciphertext,
                    name_nonce: enc.nonce,
                    channel_encrypted_name: enc.ciphertext,
                    channel_name_nonce: enc.nonce,
                    voice_channel_encrypted_name: enc.ciphertext,
                    voice_channel_name_nonce: enc.nonce,
                    invite_code: 'RAIL' + Math.random().toString(36).slice(2, 10).toUpperCase(),
                }),
            });
            if (!res.ok) { ids.push('ERR_' + res.status); continue; }
            const data = await res.json();
            ids.push(data.id);
            try { E.saveServerKey(data.id, key); } catch (_) { /* non-fatal */ }
        }
        return ids;
    }, count);
}

/**
 * Create one server plus `count` text channels under it, using the app's own
 * crypto so the sidebar can decrypt and render them.
 */
async function makeServerWithChannels(page: Page, count: number): Promise<string> {
    return await page.evaluate(async (n) => {
        const E = (window as any).E2ECrypto;
        const token = localStorage.getItem('token');
        const auth = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

        const key = E.generateSymmetricKey();
        const encName = E.aeadEncrypt('Scroll City', key);
        const sr = await fetch('/api/servers', {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
                name: 'Scroll City',
                encrypted_name: encName.ciphertext, name_nonce: encName.nonce,
                channel_encrypted_name: encName.ciphertext, channel_name_nonce: encName.nonce,
                voice_channel_encrypted_name: encName.ciphertext, voice_channel_name_nonce: encName.nonce,
                invite_code: 'CHAN' + Math.random().toString(36).slice(2, 10).toUpperCase(),
            }),
        });
        if (!sr.ok) throw new Error('server create failed: ' + sr.status);
        const sid = (await sr.json()).id;
        E.saveServerKey(sid, key);

        for (let i = 0; i < n; i++) {
            const enc = E.aeadEncrypt('chan-' + i, key);
            const cr = await fetch(`/api/servers/${sid}/channels`, {
                method: 'POST',
                headers: auth,
                body: JSON.stringify({
                    encrypted_name: enc.ciphertext,
                    name_nonce: enc.nonce,
                    channel_type: 'text',
                }),
            });
            if (!cr.ok) throw new Error('channel create failed: ' + cr.status);
        }
        return sid;
    }, count);
}

/** Reload so renderServerList() builds every rail icon from scratch. */
async function loadRail(page: Page, expected: number) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon[data-id]', { timeout: 30000 });
    await page.waitForFunction(
        (n) => document.querySelectorAll('.server-icon[data-id]').length >= n,
        expected,
        { timeout: 30000 },
    );
    await page.waitForTimeout(1200);
}

async function railMetrics(page: Page) {
    return await page.evaluate(() => {
        const el = document.getElementById('server-strip') as HTMLElement;
        return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            overflow: getComputedStyle(el).overflowY,
            icons: document.querySelectorAll('.server-icon[data-id]').length,
        };
    });
}

/**
 * Drive a real HTML5 drag on the first rail icon and hold the pointer at
 * `edge`, re-asserting `dragover` every frame window (the page's auto-scroll
 * ticker reads the last pointer position it saw).
 */
async function holdDragAtEdge(page: Page, edge: 'top' | 'bottom', ms: number) {
    return await page.evaluate(async ([which, wait]) => {
        const strip = document.getElementById('server-strip') as HTMLElement;
        const icon = document.querySelector('.server-icon[data-id]') as HTMLElement;
        if (!strip || !icon) throw new Error('rail not ready');
        const rect = strip.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = which === 'bottom' ? rect.bottom - 3 : rect.top + 3;

        const dt = new DataTransfer();
        icon.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

        const before = strip.scrollTop;
        const steps = 16;
        for (let i = 0; i < steps; i++) {
            document.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: cx, clientY: cy,
            }));
            await new Promise((r) => setTimeout(r, wait / steps));
        }
        const after = strip.scrollTop;
        icon.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return { before, after, cy };
    }, [edge, ms] as [string, number]);
}

// ---------------------------------------------------------------------------

test.describe.serial('Server rail drag auto-scroll', () => {
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(240000);
        ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        page = await ctx.newPage();
        // A short viewport with plenty of servers is what makes the rail
        // scrollable — and dragging to an off-screen folder the reason for
        // auto-scroll in the first place.
        await page.setViewportSize({ width: 1100, height: 560 });
        await register(page, unique('rail'));
        const ids = await makeServers(page, 15);
        const failed = ids.filter((id) => id.startsWith('ERR'));
        expect(failed, `server creation failed: ${failed.join(',')}`).toEqual([]);
        await loadRail(page, ids.length);
    });

    test.afterAll(async () => { await ctx.close(); });

    test('the rail overflows so folders can sit off-screen', async () => {
        const m = await railMetrics(page);
        expect(m.icons).toBeGreaterThanOrEqual(15);
        expect(m.overflow).toBe('auto');
        expect(m.scrollHeight).toBeGreaterThan(m.clientHeight + 40);
        await page.screenshot({ path: `${SHOT}/01-rail-overflow.png` });
    });

    test('holding a dragged server near the rail edge scrolls it', async () => {
        test.setTimeout(120000);
        await page.evaluate(() => { (document.getElementById('server-strip') as HTMLElement).scrollTop = 0; });

        const down = await holdDragAtEdge(page, 'bottom', 900);
        expect(down.after, 'dragging at the bottom edge scrolls the rail down')
            .toBeGreaterThan(down.before);
        await page.screenshot({ path: `${SHOT}/02-autoscroll-down.png` });

        const up = await holdDragAtEdge(page, 'top', 900);
        expect(up.after, 'dragging at the top edge scrolls the rail back up')
            .toBeLessThan(up.before);
        await page.screenshot({ path: `${SHOT}/03-autoscroll-up.png` });

        // Releasing the drag must stop the scrolling immediately.
        const rest = await page.evaluate(async () => {
            const el = document.getElementById('server-strip') as HTMLElement;
            const at = el.scrollTop;
            await new Promise((r) => setTimeout(r, 600));
            return { at, later: el.scrollTop };
        });
        expect(rest.later, 'scrolling stops after the drag ends').toBe(rest.at);
    });

    test('dragging horizontally across the app does not scroll the rail', async () => {
        test.setTimeout(120000);
        await page.evaluate(() => { (document.getElementById('server-strip') as HTMLElement).scrollTop = 0; });
        const moved = await page.evaluate(async () => {
            const strip = document.getElementById('server-strip') as HTMLElement;
            const icon = document.querySelector('.server-icon[data-id]') as HTMLElement;
            const dt = new DataTransfer();
            icon.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            const before = strip.scrollTop;
            const rect = strip.getBoundingClientRect();
            // Same vertical band as the auto-scroll test, but far to the right
            // (over the channel list) — the rail must stay put.
            for (let i = 0; i < 16; i++) {
                document.dispatchEvent(new DragEvent('dragover', {
                    bubbles: true, cancelable: true, dataTransfer: dt,
                    clientX: rect.right + 260, clientY: rect.bottom - 3,
                }));
                await new Promise((r) => setTimeout(r, 50));
            }
            const after = strip.scrollTop;
            icon.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
            return { before, after };
        });
        expect(moved.after, 'pointer away from the rail must not scroll it').toBe(moved.before);
    });

    test('dragging a channel near the sidebar edge auto-scrolls the channel list', async () => {
        test.setTimeout(180000);
        const sid = await makeServerWithChannels(page, 16);
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector(`.server-icon[data-id="${sid}"]`, { timeout: 30000 });
        await page.click(`.server-icon[data-id="${sid}"]`);
        await page.waitForFunction(
            () => document.querySelectorAll('#channel-list .channel-item[data-id]').length >= 16,
            undefined,
            { timeout: 30000 },
        );
        await page.waitForTimeout(800);

        const before = await page.evaluate(() => {
            const el = document.getElementById('channel-list') as HTMLElement;
            return {
                scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                items: el.querySelectorAll('.channel-item[data-id]').length,
            };
        });
        expect(before.items).toBeGreaterThanOrEqual(16);
        expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 40);
        await page.screenshot({ path: `${SHOT}/05-channel-list-overflow.png` });

        const result = await page.evaluate(async () => {
            const el = document.getElementById('channel-list') as HTMLElement;
            const item = el.querySelector('.channel-item[data-id]') as HTMLElement;
            if (!item) throw new Error('no channel item');
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.bottom - 4;
            const dt = new DataTransfer();
            item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            const at = el.scrollTop;
            for (let i = 0; i < 16; i++) {
                document.dispatchEvent(new DragEvent('dragover', {
                    bubbles: true, cancelable: true, dataTransfer: dt,
                    clientX: cx, clientY: cy,
                }));
                await new Promise((r) => setTimeout(r, 50));
            }
            const moved = el.scrollTop;
            item.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
            await new Promise((r) => setTimeout(r, 120));
            const stopped = el.scrollTop;
            await new Promise((r) => setTimeout(r, 400));
            return { at, moved, settled: el.scrollTop as number, stopped };
        });
        expect(result.moved, 'holding a channel drag at the sidebar edge scrolls it')
            .toBeGreaterThan(result.at);
        expect(result.settled, 'the channel list stops scrolling after the drag ends')
            .toBe(result.stopped);
        await page.screenshot({ path: `${SHOT}/06-channel-autoscroll.png` });
    });

    test('touch long-press drag near the rail edge auto-scrolls on a phone viewport', async ({ browser }) => {
        test.setTimeout(180000);
        const mctx = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block',
            viewport: { width: 390, height: 620 },
            hasTouch: true,
            isMobile: true,
            storageState: await ctx.storageState(),
        });
        const mpage = await mctx.newPage();
        await loadRail(mpage, 15);

        const before = await railMetrics(mpage);
        expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 40);

        const result = await mpage.evaluate(async () => {
            const strip = document.getElementById('server-strip') as HTMLElement;
            const icon = document.querySelector('.server-icon[data-id]') as HTMLElement;
            if (!strip || !icon) throw new Error('rail not ready');
            const r = icon.getBoundingClientRect();
            const srect = strip.getBoundingClientRect();
            const startX = r.left + r.width / 2;
            const startY = r.top + r.height / 2;
            const edgeY = srect.bottom - 6;

            function ev(type: string, x: number, y: number) {
                const touch = new Touch({
                    identifier: 1, target: icon, clientX: x, clientY: y,
                    pageX: x, pageY: y, screenX: x, screenY: y,
                    radiusX: 6, radiusY: 6, force: 1,
                });
                const active = type === 'touchend' ? [] : [touch];
                return new TouchEvent(type, {
                    bubbles: true, cancelable: true,
                    touches: active, targetTouches: active, changedTouches: [touch],
                });
            }

            strip.scrollTop = 0;
            const at = strip.scrollTop;
            icon.dispatchEvent(ev('touchstart', startX, startY));
            await new Promise((res) => setTimeout(res, 550));   // past the 350ms long-press
            // Hold the finger in the bottom edge band so the rail scrolls.
            for (let i = 0; i < 14; i++) {
                icon.dispatchEvent(ev('touchmove', startX, edgeY));
                await new Promise((res) => setTimeout(res, 50));
            }
            const moved = strip.scrollTop;
            icon.dispatchEvent(ev('touchend', startX, edgeY));
            await new Promise((res) => setTimeout(res, 200));
            const stopped = strip.scrollTop;
            await new Promise((res) => setTimeout(res, 400));
            return { at, moved, stopped, settled: strip.scrollTop };
        });

        expect(result.moved, 'holding a touch drag at the rail edge scrolls it')
            .toBeGreaterThan(result.at);
        expect(result.settled, 'the rail stops scrolling once the touch ends')
            .toBe(result.stopped);
        await mpage.screenshot({ path: `${SHOT}/04-mobile-touch-autoscroll.png` });
        await mctx.close();
    });
});
