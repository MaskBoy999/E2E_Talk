import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Reordering with real data.
 *
 * Two things are checked for each list, because the past failures were of both
 * kinds: (1) the in-between drop line must actually light up while the pointer
 * is over it — the strips existed but never received a `dragover`, so they
 * looked inert — and (2) the release must move the row and STICK (the server
 * order has to match after a reload, or the next refetch would undo it).
 */

const BASE = 'https://localhost:3443';
const PASSWORD = 'password12345';
const unique = (b: string) => `${b}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(1200);
}

async function elBox(page: Page, sel: string) {
    return await page.evaluate((s) => {
        const el = document.querySelector(s) as HTMLElement | null;
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, top: b.top, bottom: b.bottom, h: b.height, y: b.top + b.height / 2 };
    }, sel);
}

/** Press on `fromSel`, drag to `toSel` (top/centre/bottom) and HOLD. */
async function dragTo(page: Page, fromSel: string, toSel: string, part: 'center' | 'top' | 'bottom' = 'center') {
    const a = await elBox(page, fromSel);
    const b = await elBox(page, toSel);
    if (!a || !b) throw new Error('missing element ' + (!a ? fromSel : toSel));
    const targetY = part === 'top' ? b.top + 2 : part === 'bottom' ? b.bottom - 2 : b.y;
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x, a.y - 8, { steps: 3 });
    await page.mouse.move(b.x, targetY, { steps: 10 });
    // The browser throttles dragover, so give the final position a moment to be
    // reported before asserting on the indicator.
    await page.waitForTimeout(700);
    return { x: b.x, y: targetY };
}

async function makeFriends(pageA: Page, pageB: Page) {
    const codeA = await pageA.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const aId = await pageA.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').id);
    await pageB.evaluate(async (code) => {
        const t = localStorage.getItem('token');
        await fetch('/api/friends/request', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
            body: JSON.stringify({ friend_code: code }),
        });
    }, codeA);
    await pageA.evaluate(async () => {
        const t = localStorage.getItem('token');
        const h = { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' };
        const inc = await (await fetch('/api/friends/requests/incoming', { headers: h })).json();
        for (const r of inc) {
            await fetch('/api/friends/requests/accept', { method: 'POST', headers: h, body: JSON.stringify({ request_id: r.id }) });
        }
    });
    return aId;
}

test.describe('Reordering with real data', () => {
    test('DM conversations: the in-between line lights up and the new order sticks', async ({ browser }) => {
        test.setTimeout(300000);
        const ctxA: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageA = await ctxA.newPage();
        await register(pageA, unique('rdmA'));

        // Two real friends → two real conversations (the sidebar is drawn from
        // real rows, not a seeded array).
        for (let i = 0; i < 2; i++) {
            const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
            const page = await ctx.newPage();
            await register(page, unique('rdmF' + i));
            await makeFriends(pageA, page);
            await ctx.close();
        }

        await pageA.reload();
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 20000 });
        await expect.poll(async () => pageA.evaluate(() =>
            document.querySelectorAll('#dm-list .dm-item[data-dm-id]').length),
            { message: 'two conversations are on screen', timeout: 20000 }).toBe(2);

        const rows = await pageA.evaluate(() => Array.from(
            document.querySelectorAll('#dm-list .dm-item[data-dm-id]')).map((e: any) => e.dataset.dmId));
        const [first, second] = rows;

        // Drag the SECOND conversation onto the top slot.
        await dragTo(pageA, `#dm-list .dm-item[data-dm-id="${second}"]`, '#dm-list .dm-drop-gap.top');

        const mid = await pageA.evaluate(() => ({
            dragging: document.getElementById('dm-list')!.classList.contains('dm-list-dragging'),
            topActive: document.querySelectorAll('#dm-list .dm-drop-gap.top.drop-active').length,
            anyActive: document.querySelectorAll('#dm-list .dm-drop-gap.drop-active').length,
        }));
        expect(mid.dragging, 'the list knows a drag is in flight').toBe(true);
        expect(mid.topActive, 'the slot above the first conversation lights up').toBe(1);
        expect(mid.anyActive).toBe(1);

        await pageA.mouse.up();
        await pageA.waitForTimeout(1200);

        await expect.poll(async () => pageA.evaluate(() => Array.from(
            document.querySelectorAll('#dm-list .dm-item[data-dm-id]')).map((e: any) => e.dataset.dmId).join(',')),
            { message: 'the dragged conversation moved to the top' })
            .toBe(`${second},${first}`);

        // The order must be the server's, or the next refetch would undo it.
        const serverOrder = await pageA.evaluate(async () => {
            const t = localStorage.getItem('token');
            const r = await fetch('/api/dm/conversations', { headers: { 'Authorization': 'Bearer ' + t } });
            return (await r.json()).map((c: any) => c.dm_channel_id).join(',');
        });
        expect(serverOrder, 'the server stored the new order').toBe(`${second},${first}`);

        await pageA.reload();
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 20000 });
        await expect.poll(async () => pageA.evaluate(() => Array.from(
            document.querySelectorAll('#dm-list .dm-item[data-dm-id]')).map((e: any) => e.dataset.dmId).join(',')),
            { message: 'and it survives a reload', timeout: 20000 })
            .toBe(`${second},${first}`);

        await ctxA.close();
    });

    test('category header drag: indicator appears and the order changes', async ({ browser }) => {
        test.setTimeout(300000);
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        await register(page, unique('rdmCat'));

        // Create the server through the UI: it comes with two named categories
        // (and their channels) already in the client's own state.
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 15000 });
        await page.click('#choice-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 15000 });
        await page.fill('#new-server-name', 'Cat Test ' + Date.now().toString(36));
        await page.click('#confirm-create-server');
        await expect.poll(async () => page.evaluate(() =>
            document.querySelectorAll('.server-icon[data-id]').length), { timeout: 30000 }).toBeGreaterThan(0);

        const serverId = await page.evaluate(() => {
            const icons = Array.from(document.querySelectorAll('.server-icon[data-id]'));
            const last = icons[icons.length - 1] as HTMLElement;
            return last.getAttribute('data-id');
        });
        expect(serverId).toBeTruthy();
        await page.evaluate((sid) => (window as any).selectServer(sid), serverId);

        await expect.poll(async () => page.evaluate(() =>
            document.querySelectorAll('.channel-category-group[data-category-id]').length),
            { message: 'the new server shows its categories', timeout: 30000 }).toBeGreaterThanOrEqual(2);

        const cats = await page.evaluate(() => Array.from(
            document.querySelectorAll('.channel-category-group[data-category-id]'))
            .map((g: any) => g.getAttribute('data-category-id')));
        const lastCat = cats[cats.length - 1];
        const firstCat = cats[0];

        console.log('categories', JSON.stringify(cats), 'errors', JSON.stringify(errors.slice(0, 3)));

        await dragTo(page,
            `.channel-category-group[data-category-id="${lastCat}"] .channel-category-header`,
            `.channel-category-group[data-category-id="${firstCat}"] .channel-category-header`,
            'top');

        const mid = await page.evaluate(() => ({
            dragged: document.querySelectorAll('.channel-category-group.dragging').length,
            indicator: document.querySelectorAll('.drag-over-top, .drag-over-bottom').length,
        }));
        console.log('category mid-drag', JSON.stringify(mid));
        expect(mid.dragged, 'the category being dragged is marked').toBe(1);
        expect(mid.indicator, 'a drop indicator shows on the target').toBeGreaterThan(0);

        await page.mouse.up();
        await page.waitForTimeout(1800);

        const domAfter = await page.evaluate(() => Array.from(
            document.querySelectorAll('.channel-category-group[data-category-id]'))
            .map((g: any) => g.getAttribute('data-category-id')));
        expect(domAfter[0], 'the dragged category is now first').toBe(lastCat);

        const apiAfter = await page.evaluate(async (sid) => {
            const t = localStorage.getItem('token');
            const r = await fetch('/api/servers/' + sid + '/categories', { headers: { 'Authorization': 'Bearer ' + t } });
            return (await r.json()).map((c: any) => c.id);
        }, serverId);
        expect(apiAfter[0], 'the server stored the new category order').toBe(lastCat);

        await ctx.close();
    });
});
