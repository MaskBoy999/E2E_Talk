// The rendered message window.
//
// #message-list used to keep every row a session had ever loaded. A phone that
// sits in one channel for a day ends up paying for all of them: layout,
// hit-testing and paint all walk the whole list, and every blob URL held by a
// row pins its decrypted bytes in memory until the channel is switched.
//
// The window is capped (MESSAGE_DOM_SOFT_CAP rows) and trimmed by
// `pruneMessageWindow()`, which never moves what the user is looking at:
//
//   * at the bottom of the list -> the oldest rows, which are off-screen above,
//     are dropped (the browser clamps scrollTop, so the view stays on the
//     newest message);
//   * scrolled up -> the newest rows below the viewport are dropped, so the rows
//     on screen keep their position to the pixel.
//
// The rows here are built directly into the list: what is under test is the
// window arithmetic, not the 600-message history it would take to get there.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

async function registerUser(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', `win_${ts}`);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#message-list', { timeout: 30000 });
}

/** Fill the list with `n` rows the way the app does — `.message` divs. */
async function fill(page: Page, n: number, extra = '') {
    await page.evaluate(({ n, extra }) => {
        const list = document.getElementById('message-list') as HTMLElement;
        list.innerHTML = '';
        for (let i = 0; i < n; i++) {
            const d = document.createElement('div');
            d.className = 'message';
            d.setAttribute('data-message-id', 'm' + i);
            d.textContent = 'message ' + i + ' ' + extra;
            list.appendChild(d);
        }
    }, { n, extra });
}

const count = (page: Page) => page.evaluate(() => document.querySelectorAll('#message-list .message').length);
const ids = (page: Page) => page.evaluate(() =>
    Array.from(document.querySelectorAll('#message-list .message')).map((el) => el.getAttribute('data-message-id')));

test.describe('one channel can never grow an unbounded list of rows', () => {
    test('at the bottom it drops the oldest rows, and keeps the ones on screen', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        await fill(page, 700);

        // Reading the newest message, i.e. the ordinary state of a chat.
        await page.evaluate(() => {
            const list = document.getElementById('message-list') as HTMLElement;
            list.scrollTop = list.scrollHeight;
        });
        const beforeTop = await page.evaluate(() => {
            const list = document.getElementById('message-list') as HTMLElement;
            const last = list.querySelectorAll('.message')[699] as HTMLElement;
            return last.getBoundingClientRect().top;
        });

        await page.evaluate(() => (window as any).pruneMessageWindow(document.getElementById('message-list')));

        const after = await count(page);
        expect(after, 'the window must come down to the cap').toBe(600);
        const remaining = await ids(page);
        expect(remaining[0], 'the OLDEST rows are the ones dropped').toBe('m100');
        expect(remaining[remaining.length - 1], 'the newest row must survive').toBe('m699');

        // The newest message did not move on screen: dropping rows above the
        // viewport shrinks the scroll height and the browser clamps scrollTop.
        const afterTop = await page.evaluate(() => {
            const list = document.getElementById('message-list') as HTMLElement;
            const last = list.querySelectorAll('.message')[599] as HTMLElement;
            return last.getBoundingClientRect().top;
        });
        expect(Math.abs(afterTop - beforeTop), 'the visible message must not jump').toBeLessThanOrEqual(1);
    });

    test('scrolled up it drops the rows below the viewport, so the view does not move', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        await fill(page, 700);

        // Park the view around the middle of the list and remember exactly what
        // the reader is looking at.
        await page.evaluate(() => {
            const list = document.getElementById('message-list') as HTMLElement;
            list.scrollTop = 3000;
        });
        const before = await page.evaluate(() => {
            const rows = document.querySelectorAll('#message-list .message');
            const list = document.getElementById('message-list') as HTMLElement;
            let anchor: HTMLElement | null = null;
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i] as HTMLElement;
                // First row fully visible in the viewport.
                if (r.offsetTop >= list.scrollTop) { anchor = r; break; }
            }
            return {
                id: anchor ? anchor.getAttribute('data-message-id') : null,
                top: anchor ? anchor.getBoundingClientRect().top : null,
                scrollTop: list.scrollTop,
            };
        });
        expect(before.id, 'the test needs a visible row to anchor on').not.toBeNull();

        await page.evaluate(() => (window as any).pruneMessageWindow(document.getElementById('message-list')));

        const after = await page.evaluate((id) => {
            const list = document.getElementById('message-list') as HTMLElement;
            const el = list.querySelector('.message[data-message-id="' + id + '"]') as HTMLElement | null;
            return { found: !!el, top: el ? el.getBoundingClientRect().top : null, count: list.querySelectorAll('.message').length };
        }, before.id);

        expect(after.count, 'the window must come down to the cap').toBe(600);
        expect(after.found, 'the row being read must survive the trim').toBe(true);
        expect(Math.abs((after.top as number) - (before.top as number)), 'the row being read must not move').toBeLessThanOrEqual(1);
        const remaining = await ids(page);
        expect(remaining[0], 'trimming while scrolled up takes from the BOTTOM').toBe('m0');
    });

    test('a trimmed row gives its decrypted bytes back', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        await fill(page, 700);

        // The oldest row holds a picture, the way a real media message does.
        const url = await page.evaluate(() => {
            const list = document.getElementById('message-list') as HTMLElement;
            const row = list.querySelector('.message') as HTMLElement;
            const blobUrl = URL.createObjectURL(new Blob(['decrypted bytes'], { type: 'image/png' }));
            const img = document.createElement('img');
            img.src = blobUrl;
            row.appendChild(img);
            blobUrls.push(blobUrl);
            return blobUrl;
        });
        await page.evaluate(() => {
            const list = document.getElementById('message-list') as HTMLElement;
            list.scrollTop = list.scrollHeight;
            (window as any).__revoked = [];
            const realRevoke = URL.revokeObjectURL.bind(URL);
            (URL as any).revokeObjectURL = (u: string) => { (window as any).__revoked.push(u); return realRevoke(u); };
        });

        await page.evaluate(() => (window as any).pruneMessageWindow(document.getElementById('message-list')));

        const revoked = await page.evaluate(() => (window as any).__revoked as string[]);
        expect(revoked, 'trimming a row must release the blob its <img> held').toContain(url);
        expect(await page.evaluate((u) => blobUrls.indexOf(u), url), 'the registry must not leak the URL').toBe(-1);
    });

    test('under the cap nothing is touched', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        await fill(page, 100);
        await page.evaluate(() => (window as any).pruneMessageWindow(document.getElementById('message-list')));
        expect(await count(page)).toBe(100);
        expect((await ids(page))[0]).toBe('m0');
    });
});
