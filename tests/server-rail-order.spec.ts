import { test, expect, type Page } from '@playwright/test';

/**
 * The rail's ordering model, driven against synthetic state.
 *
 * Why not the API: creating servers is capped at 30 per user per hour
 * (`CREATE_SERVER_RATE_LIMITER` in `server/src/handlers.rs`), which makes the
 * real-data drag spec unrunnable while you are iterating, and the ordering rules
 * themselves are pure client logic. Seeding the app's own `servers`/
 * `serverGroups` and driving real mouse events exercises exactly the code a real
 * drag does. The API round-trip is covered by `server-rail-dragdrop.spec.ts`.
 */

const BASE = 'https://localhost:3443';
const PASSWORD = 'testpass1234';
/** Same fixed account as the drag spec: reused, so no registration per run. */
const USER = 'rail_dragdrop_user';

async function ensureUser(page: Page) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#login-form', { timeout: 20000 });
    await page.fill('#login-username', USER);
    await page.fill('#login-password', PASSWORD);
    await page.click('#login-form button[type="submit"]');
    const loggedIn = await page
        .waitForURL('**/index.html', { timeout: 60000 })
        .then(() => true)
        .catch(() => false);
    if (!loggedIn) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 20000 });
        await page.click('#show-register');
        await page.waitForSelector('#register-form', { state: 'visible' });
        await page.fill('#register-username', USER);
        await page.fill('#register-password', PASSWORD);
        await page.fill('#register-confirm-password', PASSWORD);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 90000 });
    }
    await page.waitForSelector('#current-user', { timeout: 20000 });
    await page.waitForTimeout(1000);
}

/**
 * Seed the rail and keep the seed: the app refetches servers/groups on
 * heartbeat and WS events, which would otherwise replace the synthetic list
 * mid-drag. Sub-paths (`/reorder`, `/group`, …) pass through untouched.
 */
async function seedRail(page: Page, servers: unknown[], groups: unknown[]) {
    await page.evaluate(([sv, gr]) => {
        const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }));
        const realFetch = window.fetch.bind(window);
        window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
            const url = typeof input === 'string' ? input : (input as Request).url || String(input);
            const method = (init && init.method) || 'GET';
            if (method === 'GET' && /\/api\/servers$/.test(url)) return json(sv);
            if (method === 'GET' && /\/api\/server-groups$/.test(url)) return json({ ok: true, groups: gr });
            return realFetch(input, init);
        };
        // `servers`/`serverGroups` are top-level `let` bindings: reachable as
        // bare identifiers in global scope, not through `window`.
        (0, eval)(`servers = ${JSON.stringify(sv)}; serverGroups = ${JSON.stringify(gr)}; renderServerList();`);
    }, [servers, groups]);
}

async function railOrder(page: Page): Promise<string[]> {
    return await page.evaluate(() =>
        Array.from(document.querySelectorAll('#server-list .server-icon[data-id]'))
            .map((el) => (el as HTMLElement).dataset.id || ''));
}

async function readServers(page: Page): Promise<Array<{ id: string; position: number; group_id: string | null }>> {
    return await page.evaluate(() =>
        (0, eval)('servers.map(s => ({ id: s.id, position: s.position, group_id: s.group_id }))'));
}

/** Measured in-page: the thin slot blocks confuse the locator API's box query. */
async function centerOf(page: Page, selector: string) {
    const box = await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
    if (!box) throw new Error(`no box for ${selector}`);
    return box;
}

async function dragOnto(page: Page, fromSelector: string, toSelector: string) {
    const from = await centerOf(page, fromSelector);
    const to = await centerOf(page, toSelector);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // A few px first: Chromium only starts a native drag past its own threshold.
    await page.mouse.move(from.x + 8, from.y + 8, { steps: 3 });
    await page.waitForTimeout(120);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
        await page.mouse.move(
            from.x + ((to.x - from.x) * i) / steps,
            from.y + ((to.y - from.y) * i) / steps,
        );
        await page.waitForTimeout(60);
    }
    await page.mouse.move(to.x, to.y);
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(250);
}

test.describe.serial('Server rail order and slots', () => {
    test('folders interleave with loose servers, and every slot means one thing', async ({ page }) => {
        test.setTimeout(180000);
        await ensureUser(page);

        // A folder of two members in the middle of three loose servers.
        // Positions are one sequence, so the folder sits where its first member
        // sits — it is not pinned above the loose servers any more.
        await seedRail(page,
            [
                { id: 's1', name: 'S1', position: 0, group_id: null },
                { id: 's2', name: 'S2', position: 1, group_id: 'g1' },
                { id: 's3', name: 'S3', position: 2, group_id: 'g1' },
                { id: 's4', name: 'S4', position: 3, group_id: null },
                { id: 's5', name: 'S5', position: 4, group_id: null },
            ],
            [{ id: 'g1', name: 'Folder', position: 0, collapsed: false, color: null }]);

        await expect.poll(() => railOrder(page)).toEqual(['s1', 's2', 's3', 's4', 's5']);
        await expect(page.locator('#server-list > .server-drop-gap.top')).toHaveCount(1);

        // 0. The slot immediately after the thing being dragged is not a move —
        // a mouse overshoot, and where a fingertip usually lands. It used to
        // drop the item at the end of the rail.
        await dragOnto(page, '.server-icon[data-id="s1"]',
            '#server-list > .server-drop-gap[data-after-server="s1"]');
        await expect.poll(() => railOrder(page)).toEqual(['s1', 's2', 's3', 's4', 's5']);
        await dragOnto(page, '.server-group[data-group-id="g1"] .server-group-header',
            '#server-list > .server-drop-gap[data-after-group="g1"]');
        await expect.poll(() => railOrder(page)).toEqual(['s1', 's2', 's3', 's4', 's5']);

        // 1. The slot *below* the folder: the server stays outside it.
        await dragOnto(page, '.server-icon[data-id="s1"]',
            '#server-list > .server-drop-gap[data-after-group="g1"]');
        await expect.poll(async () => (await readServers(page)).find((s) => s.id === 's1')!.group_id).toBeNull();
        await expect.poll(() => railOrder(page)).toEqual(['s2', 's3', 's1', 's4', 's5']);

        // 2. A slot *inside* the expanded folder: between its two members.
        await dragOnto(page, '.server-icon[data-id="s5"]',
            '#server-list .server-drop-gap.inside[data-after-server="s2"]');
        await expect.poll(async () => (await readServers(page)).find((s) => s.id === 's5')!.group_id).toBe('g1');
        await expect.poll(() => railOrder(page)).toEqual(['s2', 's5', 's3', 's1', 's4']);

        // 3. The slot above everything.
        await dragOnto(page, '.server-icon[data-id="s4"]', '#server-list > .server-drop-gap.top');
        await expect.poll(() => railOrder(page)).toEqual(['s4', 's2', 's5', 's3', 's1']);
        await expect.poll(async () => (await readServers(page)).find((s) => s.id === 's4')!.position).toBe(0);

        // 4. A folder dragged into a slot like a server: its members travel along.
        await dragOnto(page, '.server-group[data-group-id="g1"] .server-group-header',
            '#server-list > .server-drop-gap[data-after-server="s1"]');
        await expect.poll(() => railOrder(page)).toEqual(['s4', 's1', 's2', 's5', 's3']);
        const groups: Record<string, string | null> = {};
        const members = await readServers(page);
        for (const s of members) groups[s.id] = s.group_id;
        expect(groups['s2'], 'the folder kept its members').toBe('g1');
        expect(groups['s5'], 'the folder kept its members').toBe('g1');
        expect(groups['s3'], 'the folder kept its members').toBe('g1');

        // Nothing left running after the last drop.
        const state = await page.evaluate(() => ({
            active: (0, eval)('_serverDragActive === true'),
            listDragging: document.getElementById('server-list')!.classList.contains('server-list-dragging'),
            ghosts: document.querySelectorAll('body > .server-drag-ghost').length,
        }));
        expect(state.active, 'the drag finished').toBe(false);
        expect(state.listDragging, 'the rail is not stuck in drag mode').toBe(false);
        expect(state.ghosts, 'no ghost left behind').toBe(0);
    });

    test('a folder with no members and orphaned servers still render', async ({ page }) => {
        test.setTimeout(180000);
        await ensureUser(page);

        // A group_id pointing at a folder that no longer exists, plus a folder
        // that has none yet: both have to render (and the orphans order like the
        // loose servers they look like).
        await seedRail(page,
            [
                { id: 'o1', name: 'Orphan', position: 0, group_id: 'gone' },
                { id: 's1', name: 'S1', position: 1, group_id: null },
            ],
            [{ id: 'g-empty', name: 'Empty', position: 0, collapsed: false, color: null }]);

        await expect.poll(() => railOrder(page)).toEqual(['o1', 's1']);
        await expect(page.locator('.server-group[data-group-id="g-empty"]'),
            'an empty folder still renders').toHaveCount(1);
        await expect(page.locator('.server-group[data-group-id="gone"]'),
            'a folder that no longer exists renders nothing').toHaveCount(0);
    });
});
