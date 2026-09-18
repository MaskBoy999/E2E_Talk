import { test, expect, devices, type Page, type BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASSWORD = 'testpass1234';
const SHOT = 'test-results/server-rail-dragdrop';

/**
 * A fixed account, reused across runs: registering is rate limited to 5 new
 * accounts per IP per 10 minutes, so a spec that mints a fresh user every run
 * cannot be re-run while you are iterating on a drag bug.
 */
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
}

/** Leave (owner-leaving deletes) every server so each run starts on a known rail. */
async function resetRail(page: Page) {
    await page.evaluate(async () => {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/servers', { headers: { Authorization: 'Bearer ' + token } });
        const list = await res.json();
        for (const s of list) {
            await fetch(`/api/servers/${s.id}/leave`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token },
            }).catch(() => { /* best effort */ });
        }
    });
}

/** Create `count` servers through the API with the app's own crypto, like the
 *  create flow does, so the rail renders them with valid decrypted names. */
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
                    invite_code: 'DRAG' + Math.random().toString(36).slice(2, 10).toUpperCase(),
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

async function loadRail(page: Page, expected: number) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon[data-id]', { timeout: 30000 });
    await page.waitForFunction(
        (n) => document.querySelectorAll('#server-list .server-icon[data-id]').length >= n,
        expected,
        { timeout: 30000 },
    );
    await page.waitForTimeout(1000);
}

/** Rail order as rendered (group members inline, in DOM order). */
async function railOrder(page: Page): Promise<string[]> {
    return await page.evaluate(() =>
        Array.from(document.querySelectorAll('#server-list .server-icon[data-id]'))
            .map((el) => (el as HTMLElement).dataset.id || ''));
}

/** Order the server persists, sorted by position. */
async function apiOrder(page: Page): Promise<string[]> {
    return await page.evaluate(async () => {
        const res = await fetch('/api/servers', {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const list = await res.json();
        return list.slice()
            .sort((a: any, b: any) => (a.position || 0) - (b.position || 0))
            .map((s: any) => s.id);
    });
}

/** Load the app and wait for the rail to settle, without assuming a count. */
async function reloadRail(page: Page) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon[data-id]', { timeout: 30000 });
    await page.waitForTimeout(1200);
}

/**
 * Make sure the rail holds a folder with at least two members and return it,
 * members in rail order. Creates one through the API if the account has none,
 * so these tests do not depend on another test having folded servers first.
 */
async function ensureFolder(page: Page): Promise<{ gid: string; members: string[] }> {
    await reloadRail(page);
    const groups = await groupByServer(page);
    const byGroup: Record<string, string[]> = {};
    for (const [sid, gid] of Object.entries(groups)) {
        if (!gid) continue;
        (byGroup[gid] = byGroup[gid] || []).push(sid);
    }
    const order = await apiOrder(page);
    const existing = Object.entries(byGroup).find(([, ids]) => ids.length >= 2);
    if (existing) {
        return {
            gid: existing[0],
            members: existing[1].slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)),
        };
    }
    const loose = order.filter((id) => !groups[id]);
    if (loose.length < 2) throw new Error('need two loose servers to build a folder');
    const members = loose.slice(0, 2);
    const gid = await page.evaluate(async (ids: string[]) => {
        const token = localStorage.getItem('token');
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
        const res = await fetch('/api/server-groups', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'Drag Folder' }),
        });
        const data = await res.json();
        if (!data.ok || !data.id) throw new Error('group create failed');
        for (const id of ids) {
            await fetch(`/api/servers/${id}/group`, {
                method: 'PUT',
                headers,
                body: JSON.stringify({ group_id: data.id }),
            });
        }
        return data.id as string;
    }, members);
    await reloadRail(page);
    return { gid, members };
}

/** Click the folder open/closed until the DOM agrees — the same path a user takes. */
async function setFolderExpanded(page: Page, gid: string, expanded: boolean) {
    const inner = page.locator(`.server-group[data-group-id="${gid}"] .server-group-inner`);
    for (let i = 0; i < 4; i++) {
        if (((await inner.count()) > 0) === expanded) return;
        await page.locator(`.server-group[data-group-id="${gid}"] .server-group-header`).click();
        await page.waitForTimeout(400);
    }
    throw new Error(`folder ${gid} never became ${expanded ? 'expanded' : 'collapsed'}`);
}

async function groupByServer(page: Page): Promise<Record<string, string | null>> {
    return await page.evaluate(async () => {
        const res = await fetch('/api/servers', {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const list = await res.json();
        const out: Record<string, string | null> = {};
        for (const s of list) out[s.id] = s.group_id || null;
        return out;
    });
}

/** Everything the rail should have torn down when a drag ends. */
async function dragState(page: Page) {
    return await page.evaluate(() => ({
        active: (window as any)._serverDragActive === true,
        pending: (window as any)._serverDragPendingRerender === true,
        listDragging: document.getElementById('server-list')!.classList.contains('server-list-dragging'),
        draggingIcons: document.querySelectorAll('#server-list .dragging').length,
        activeGaps: document.querySelectorAll('#server-list .server-drop-gap.drop-active').length,
        groupRings: document.querySelectorAll('#server-list .drag-over-group').length,
        ghosts: document.querySelectorAll('body > .server-drag-ghost').length,
        stripScroll: (document.getElementById('server-strip') as HTMLElement).scrollTop,
    }));
}

/**
 * A finished drag must leave nothing behind: no drag flag, no rail styling, no
 * ghost parked on <body>, no stuck drop indicator, no runaway auto-scroll.
 * This is the "keeps dragging on endlessly" failure mode.
 */
async function expectDragFullyEnded(page: Page, label: string) {
    const st = await dragState(page);
    expect(st.active, `${label}: _serverDragActive must be cleared`).toBe(false);
    expect(st.listDragging, `${label}: server-list-dragging class removed`).toBe(false);
    expect(st.draggingIcons, `${label}: no element left in .dragging`).toBe(0);
    expect(st.activeGaps, `${label}: drop indicator cleared`).toBe(0);
    expect(st.groupRings, `${label}: group ring cleared`).toBe(0);
    expect(st.ghosts, `${label}: touch ghost removed from <body>`).toBe(0);

    const before = st.stripScroll;
    await page.waitForTimeout(450);
    const after = await dragState(page);
    expect(after.stripScroll, `${label}: rail auto-scroll stopped`).toBe(before);
}

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`no bounding box for ${selector}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Mouse drag with real input events. Leaves the button UP on purpose — callers
 * assert mid-drag state in between and finish with `page.mouse.up()`.
 */
async function startMouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // A few px first: Chromium only starts a native drag past its own threshold.
    await page.mouse.move(from.x + 8, from.y + 8, { steps: 3 });
    await page.waitForTimeout(120);
    // Real hands move slower than Playwright does. Firing the whole path in one
    // `mouse.move` gets coalesced by Chromium, so the last dragover lands short
    // of the target and the drop goes to whatever was under that stale point.
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
        await page.mouse.move(
            from.x + ((to.x - from.x) * i) / steps,
            from.y + ((to.y - from.y) * i) / steps,
        );
        await page.waitForTimeout(60);
    }
    await page.mouse.move(to.x, to.y);   // settle exactly on the target
    await page.waitForTimeout(200);
}

/**
 * Long-press drag driven through CDP Input.dispatchTouchEvent, i.e. through the
 * real input pipeline (compositor hit-testing, touch-action, scroll takeover)
 * instead of synthetic `dispatchEvent` TouchEvents. That difference is exactly
 * why a resized desktop window can pass while a real phone does not.
 */
async function touchLongPressDrag(
    page: Page,
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts: { onHold?: () => Promise<void>; holdMs?: number } = {},
) {
    const cdp = await page.context().newCDPSession(page);
    const point = (x: number, y: number) => [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
    try {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) });
        // Hold still past the app's long-press delay (320ms).
        await page.waitForTimeout(opts.holdMs ?? 550);
        if (opts.onHold) await opts.onHold();
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
            const x = from.x + ((to.x - from.x) * i) / steps;
            const y = from.y + ((to.y - from.y) * i) / steps;
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) });
            await page.waitForTimeout(25);
        }
        await page.waitForTimeout(120);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(500);
    } finally {
        await cdp.detach().catch(() => { /* already gone */ });
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

test.describe.serial('Server rail drag and drop', () => {
    let ctx: BrowserContext;
    let page: Page;
    let serverIds: string[] = [];

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(240000);
        ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        page = await ctx.newPage();
        await page.setViewportSize({ width: 1280, height: 800 });
        await ensureUser(page);
        await resetRail(page);
        serverIds = await makeServers(page, 6);
        const failed = serverIds.filter((id) => id.startsWith('ERR'));
        expect(failed, `server creation failed: ${failed.join(',')}`).toHaveLength(0);
        await loadRail(page, serverIds.length);
    });

    test.afterAll(async () => { await ctx.close(); });

    test('mouse user: the drag shows a ghost + gap indicators, and the drop reorders + persists', async () => {
        test.setTimeout(120000);
        const before = await railOrder(page);
        expect(before.length).toBeGreaterThanOrEqual(6);

        // Gap that sits immediately after the third rail item.
        const anchor = before[2];
        const gapSel = `#server-list .server-drop-gap[data-after-server="${anchor}"]`;
        await expect(page.locator(gapSel), 'the rail renders drop gaps between items').toHaveCount(1);

        // A gap you cannot point at is not a drop target: it must cover real
        // area and be the element under its own centre.
        const geom = await page.evaluate((sel) => {
            const g = document.querySelector(sel) as HTMLElement | null;
            if (!g) return null;
            const r = g.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
                w: Math.round(r.width),
                h: Math.round(r.height),
                hitIsGap: !!(hit && hit.closest && hit.closest('.server-drop-gap')),
                hitTag: hit ? hit.className : 'none',
            };
        }, gapSel);
        expect(geom!.w, 'the drop gap must be wide enough to be hit').toBeGreaterThan(10);
        expect(geom!.hitIsGap, `the element under the gap centre must be the gap (got ${geom!.hitTag})`).toBe(true);

        const gap = await centerOf(page, gapSel);
        const from = await centerOf(page, `.server-icon[data-id="${before[0]}"]`);

        await startMouseDrag(page, from, gap);

        // ---- mid-drag: indicators up, source dimmed, re-renders held off ----
        const mid = await dragState(page);
        expect(mid.active, 'a drag is in flight').toBe(true);
        expect(mid.listDragging, 'the rail marks itself as dragging so gaps are visible').toBe(true);
        expect(mid.activeGaps, 'the gap under the pointer is highlighted').toBeGreaterThan(0);
        expect(mid.ghosts, 'the mouse path must not leave a touch ghost').toBe(0);
        await page.screenshot({ path: `${SHOT}/01-mouse-dragging.png` });

        await page.mouse.up();

        // ---- after the drop: new order, persisted, nothing left running ----
        const expected = [before[1], before[2], before[0], ...before.slice(3)];
        await expect
            .poll(() => railOrder(page), { message: 'dragged server lands right after the anchor' })
            .toEqual(expected);
        await expect
            .poll(() => apiOrder(page), { message: 'the new rail order is saved to the server' })
            .toEqual(expected);
        await expectDragFullyEnded(page, 'after a mouse drop');
        await page.screenshot({ path: `${SHOT}/02-mouse-dropped.png` });
    });

    test('mouse user: a re-render requested mid-drag is deferred, then flushed on drop', async () => {
        test.setTimeout(120000);
        const before = await railOrder(page);
        const from = await centerOf(page, `.server-icon[data-id="${before[4]}"]`);
        const gapSel = `#server-list .server-drop-gap[data-after-server="${before[1]}"]`;
        const gap = await centerOf(page, gapSel);

        // Tag the live DOM node so we can prove it survived the re-render.
        await page.evaluate((id) => {
            const el = document.querySelector(`#server-list .server-icon[data-id="${id}"]`) as any;
            el.__dragProbe = 'source';
        }, before[4]);

        await startMouseDrag(page, from, gap);

        // A WS event (groups_changed / blob_updated / …) calls this mid-drag.
        await page.evaluate(() => (window as any).renderServerList());
        await page.waitForTimeout(150);

        const mid = await page.evaluate(() => ({
            active: (window as any)._serverDragActive === true,
            pending: (window as any)._serverDragPendingRerender === true,
            sourceNodeAlive: Array.from(document.querySelectorAll('#server-list .server-icon'))
                .some((el: any) => el.__dragProbe === 'source'),
        }));
        expect(mid.active, 'the drag still owns the rail').toBe(true);
        // The render must NOT have replaced the DOM under the drag: if it had,
        // the drag source and every listener on it would be gone, the drop would
        // never land, and the rail would stay wedged mid-drag.
        expect(mid.sourceNodeAlive, 'mid-drag re-render must not rebuild the rail').toBe(true);
        expect(mid.pending, 'the render is queued instead of dropped on the floor').toBe(true);

        await page.mouse.up();

        // ...and the queued render is flushed, so the rail shows the new order.
        const expected = [...before];
        const [moved] = expected.splice(4, 1);
        expected.splice(2, 0, moved);   // index 1 keeps its place, the dragged one follows it
        await expect
            .poll(() => railOrder(page), { message: 'queued render flushed with the new order' })
            .toEqual(expected);
        await expect
            .poll(() => apiOrder(page), { message: 'order persisted after a mid-drag re-render' })
            .toEqual(expected);
        await expectDragFullyEnded(page, 'after a mid-drag re-render');
    });

    test('mouse user: a lost drag source or Escape cannot wedge the rail in drag mode', async () => {
        test.setTimeout(120000);

        // (1) The drag source is wiped mid-drag by an unrelated full re-render.
        // Native `dragend` fires on that source only, so the browser never tells
        // us the drag is over — the safety net has to finish it.
        let order = await railOrder(page);
        let from = await centerOf(page, `.server-icon[data-id="${order[0]}"]`);
        await startMouseDrag(page, from, { x: from.x + 30, y: from.y + 120 });
        expect((await dragState(page)).active, 'drag started').toBe(true);

        await page.evaluate(() => {
            (document.getElementById('server-list') as HTMLElement).innerHTML = '';
        });
        // The page-side equivalent of "released outside the window / lost dragend".
        await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
        await sleep(200);
        await expectDragFullyEnded(page, 'after losing the drag source');

        // The guard must not have stuck: a fresh render has to work again.
        await page.evaluate(() => (window as any).renderServerList());
        await page.waitForSelector('#server-list .server-icon[data-id]', { timeout: 20000 });
        expect((await railOrder(page)).length).toBeGreaterThanOrEqual(6);

        // (2) Escape pressed mid-drag.
        order = await railOrder(page);
        from = await centerOf(page, `.server-icon[data-id="${order[0]}"]`);
        await startMouseDrag(page, from, { x: from.x + 30, y: from.y + 120 });
        await page.keyboard.press('Escape');
        await sleep(300);
        await page.mouse.up();
        await sleep(300);
        await expectDragFullyEnded(page, 'after Escape');
        await page.screenshot({ path: `${SHOT}/03-mouse-drag-cancelled.png` });
    });

    test('mouse user: a browser pointer artifact mid-hold must not end the drag', async () => {
        test.setTimeout(120000);
        // Browsers emit pointer events while their own drag session is running:
        // Chrome fires `pointercancel` the moment a drag starts, and some engines
        // fire a synthetic `mouseup` as the drag is handed to the OS. Neither is
        // a release. Treating one as a release ends the drag while the button is
        // still down — the drop indicators vanish, the parked render rebuilds the
        // rail under the live session, and the release that follows lands on
        // nothing. No timing window can tell these apart from a real release, so
        // pointer events must not end a drag whose session is still alive.
        const before = await railOrder(page);
        expect(before.length).toBeGreaterThanOrEqual(4);
        const from = await centerOf(page, `.server-icon[data-id="${before[0]}"]`);
        const gapSel = `#server-list .server-drop-gap[data-after-server="${before[2]}"]`;
        const gap = await centerOf(page, gapSel);

        await page.evaluate((id) => {
            const el = document.querySelector(`#server-list .server-icon[data-id="${id}"]`) as any;
            el.__dragProbe = 'source';
        }, before[0]);

        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 8, from.y + 8, { steps: 3 });
        await page.waitForTimeout(150);
        expect((await dragState(page)).active, 'drag started').toBe(true);

        // A WS event asks for a re-render, which gets parked behind the drag.
        await page.evaluate(() => (window as any).renderServerList());
        await page.waitForTimeout(500);

        // ...then the artifacts a live browser drag emits arrive, long after any
        // "it just started, ignore input" heuristic would have expired.
        await page.evaluate(() => {
            document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        });
        await page.waitForTimeout(300);

        const held = await page.evaluate(() => ({
            active: (window as any)._serverDragActive === true,
            listDragging: document.getElementById('server-list')!.classList.contains('server-list-dragging'),
            sourceNodeAlive: Array.from(document.querySelectorAll('#server-list .server-icon'))
                .some((el: any) => el.__dragProbe === 'source'),
            pending: (window as any)._serverDragPendingRerender === true,
        }));
        expect(held.active, 'a pointer artifact must not end a held drag').toBe(true);
        expect(held.listDragging, 'the drop indicators stay up while the button is held').toBe(true);
        expect(held.sourceNodeAlive, 'the parked render must not rebuild the rail mid-session').toBe(true);
        expect(held.pending, 'the render stays queued until the session ends').toBe(true);

        // The session is still alive, so the release still drops.
        await page.mouse.move(gap.x, gap.y);
        await page.waitForTimeout(200);
        await page.mouse.up();

        const expected = [...before];
        const [moved] = expected.splice(0, 1);
        expected.splice(2, 0, moved);
        await expect
            .poll(() => railOrder(page), { message: 'the drop still lands after the artifacts' })
            .toEqual(expected);
        await expect
            .poll(() => apiOrder(page), { message: 'and the order persists' })
            .toEqual(expected);
        await expectDragFullyEnded(page, 'after a stray pointer artifact');
        await page.screenshot({ path: `${SHOT}/03b-stray-cancel-ignored.png` });
    });

    test('phone user: a real touch long-press drag picks a server up and drops it onto another', async ({ browser }) => {
        test.setTimeout(180000);
        const mcontext = await browser.newContext({
            ...devices['Pixel 5'],
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block',
            storageState: await ctx.storageState(),
        });
        const mpage = await mcontext.newPage();
        try {
            await loadRail(mpage, serverIds.length);

            const groups = await groupByServer(mpage);
            const flat = (await railOrder(mpage)).filter((id) => !groups[id]);
            expect(flat.length, 'need two ungrouped servers to fold into a folder').toBeGreaterThanOrEqual(2);
            const source = flat[0];
            const target = flat[1];
            const from = await centerOf(mpage, `.server-icon[data-id="${source}"]`);
            const to = await centerOf(mpage, `.server-icon[data-id="${target}"]`);

            let held: any = null;
            await touchLongPressDrag(mpage, from, to, {
                onHold: async () => {
                    held = await mpage.evaluate(() => {
                        const g = document.querySelector('body > .server-drag-ghost') as HTMLElement | null;
                        const r = g ? g.getBoundingClientRect() : null;
                        return {
                            active: (window as any)._serverDragActive === true,
                            ghosts: document.querySelectorAll('body > .server-drag-ghost').length,
                            w: r ? Math.round(r.width) : 0,
                            h: r ? Math.round(r.height) : 0,
                            keepsIconClass: g ? g.classList.contains('server-icon') : false,
                            pointerEvents: g ? getComputedStyle(g).pointerEvents : 'n/a',
                        };
                    });
                },
            });

            // Pick-up: the ghost must be a real server-sized preview, not the
            // collapsed empty box a clone renders as when it loses .server-icon.
            expect(held.active, 'the long press armed a drag').toBe(true);
            expect(held.ghosts, 'exactly one ghost follows the finger').toBe(1);
            expect(held.keepsIconClass, 'the ghost keeps the server-icon class').toBe(true);
            expect(held.w, 'the ghost is server sized').toBeGreaterThan(24);
            expect(held.h, 'the ghost is server sized').toBeGreaterThan(24);
            expect(held.pointerEvents, 'the ghost must not block elementFromPoint').toBe('none');
            await mpage.screenshot({ path: `${SHOT}/04-phone-dragging.png` });

            // Drop onto a sibling icon: the two servers must end up in a folder.
            await expect
                .poll(async () => (await groupByServer(mpage))[source], {
                    message: 'dropping one server on another groups them',
                    timeout: 15000,
                })
                .not.toBeNull();
            const after = await groupByServer(mpage);
            expect(after[target], 'the target server joined the same folder').toBe(after[source]);
            await expectDragFullyEnded(mpage, 'after a phone drop');
            await mpage.screenshot({ path: `${SHOT}/05-phone-dropped.png` });
        } finally {
            await mcontext.close();
        }
    });

    test('phone user: a real touch drag onto a gap reorders the rail and leaves no ghost', async ({ browser }) => {
        test.setTimeout(180000);
        const mcontext = await browser.newContext({
            ...devices['Pixel 5'],
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block',
            storageState: await ctx.storageState(),
        });
        const mpage = await mcontext.newPage();
        try {
            await loadRail(mpage, serverIds.length);

            // Two ungrouped servers, so the gap between them is a pure reorder.
            const groups = await groupByServer(mpage);
            const flat = (await railOrder(mpage)).filter((id) => !groups[id]);
            expect(flat.length, 'need two ungrouped servers for this test').toBeGreaterThanOrEqual(2);

            const from = await centerOf(mpage, `.server-icon[data-id="${flat[1]}"]`);
            const gap = await centerOf(mpage, `#server-list .server-drop-gap[data-after-server="${flat[0]}"]`);

            await touchLongPressDrag(mpage, from, gap);

            // The dragged server must now sit right behind the gap's anchor, and
            // the rail + API must agree on the new order.
            await expect
                .poll(async () => {
                    const order = await railOrder(mpage);
                    return order.indexOf(flat[1]) - order.indexOf(flat[0]);
                }, { message: 'the phone drop landed in the gap' })
                .toBe(1);
            await expect
                .poll(async () => {
                    const dom = await railOrder(mpage);
                    return JSON.stringify(dom) === JSON.stringify(await apiOrder(mpage));
                }, { message: 'phone reorder persisted' })
                .toBe(true);
            await expectDragFullyEnded(mpage, 'after a phone gap drop');
            await mpage.screenshot({ path: `${SHOT}/06-phone-reordered.png` });
        } finally {
            await mcontext.close();
        }
    });

    test('phone user: releasing where there is no target still lands in the nearest gap', async ({ browser }) => {
        test.setTimeout(180000);
        const mcontext = await browser.newContext({
            ...devices['Pixel 5'],
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block',
            storageState: await ctx.storageState(),
        });
        const mpage = await mcontext.newPage();
        try {
            await loadRail(mpage, serverIds.length);

            const groups = await groupByServer(mpage);
            const flat = (await railOrder(mpage)).filter((id) => !groups[id]);
            expect(flat.length, 'need a source plus a few anchors').toBeGreaterThanOrEqual(4);
            const source = flat[0];
            const anchor = flat[2];

            const gapBox = await mpage
                .locator(`#server-list .server-drop-gap[data-after-server="${anchor}"]`)
                .first()
                .boundingBox();
            if (!gapBox) throw new Error('no gap bounding box');
            // A few px below the gap, inside the rail's flex spacing: neither a
            // drop gap nor an icon. A real thumb is far too fat for a 10px band,
            // so this is where mobile drops actually let go.
            const point = { x: gapBox.x + gapBox.width / 2, y: gapBox.y + gapBox.height + 3 };

            const under = await mpage.evaluate(([x, y]) => {
                const el = document.elementFromPoint(x as number, y as number) as HTMLElement | null;
                return el ? {
                    cls: el.className || el.tagName,
                    isGap: !!el.closest('.server-drop-gap'),
                    isIcon: !!el.closest('.server-icon'),
                } : null;
            }, [point.x, point.y]);
            expect(under, 'the probe point exists').not.toBeNull();
            expect(under!.isGap, `probe point must not already be a gap (got ${under!.cls})`).toBe(false);
            expect(under!.isIcon, `probe point must not be an icon (got ${under!.cls})`).toBe(false);

            const from = await centerOf(mpage, `.server-icon[data-id="${source}"]`);
            await touchLongPressDrag(mpage, from, point);

            // Without the nearest-gap fallback this release resolves to nothing
            // and the rail never moves — the "picks up but never drops" report.
            await expect
                .poll(async () => {
                    const order = await railOrder(mpage);
                    return order.indexOf(source) - order.indexOf(anchor);
                }, { message: 'release lands in the nearest gap instead of nowhere' })
                .toBe(1);
            await expectDragFullyEnded(mpage, 'after a phone dead-space drop');
            await mpage.screenshot({ path: `${SHOT}/07-phone-dead-space.png` });
        } finally {
            await mcontext.close();
        }
    });

    test('mouse user: a collapsed folder drags to a slot like a server, whole and persisted', async () => {
        test.setTimeout(120000);
        // "We can't drag a closed group like a server" — a folder only offered
        // itself as a drop target for *other folders*, so a folder drag anywhere
        // else resolved to nothing. The slots take folders now.
        const folder = await ensureFolder(page);
        await setFolderExpanded(page, folder.gid, false);

        const groups = await groupByServer(page);
        const order = await railOrder(page);
        const loose = order.filter((id) => !groups[id]);
        expect(loose.length, 'need a loose anchor to drop the folder next to').toBeGreaterThanOrEqual(2);

        // Aim at the end of the rail the folder is *not* already at, so the drop
        // has to move it rather than trivially landing where it already was.
        const folderIsLast = order.indexOf(folder.members[folder.members.length - 1]) === order.length - 1;
        const anchor = folderIsLast ? loose[0] : loose[loose.length - 1];
        const gapSel = `#server-list > .server-drop-gap[data-after-server="${anchor}"]`;
        await expect(page.locator(gapSel), 'the slot after a loose server exists').toHaveCount(1);

        const gap = await centerOf(page, gapSel);
        const from = await centerOf(page, `.server-group[data-group-id="${folder.gid}"] .server-group-header`);
        await startMouseDrag(page, from, gap);

        const mid = await dragState(page);
        expect(mid.active, 'a folder drag is in flight').toBe(true);
        expect(mid.draggingIcons, 'the folder marks itself as dragged').toBeGreaterThan(0);
        expect(mid.activeGaps, 'the slot under the pointer highlights for a folder too').toBeGreaterThan(0);

        await page.mouse.up();

        // The whole folder moved: every member sits right behind the anchor, in
        // order, still in the same folder — and the server agrees.
        await expect
            .poll(async () => {
                const o = await apiOrder(page);
                const base = o.indexOf(anchor);
                return folder.members.every((m, i) => o.indexOf(m) === base + 1 + i);
            }, { message: 'the folder lands behind the anchor with its members intact' })
            .toBe(true);
        const after = await groupByServer(page);
        for (const m of folder.members) {
            expect(after[m], 'every member stayed in the folder').toBe(folder.gid);
        }
        await expect
            .poll(async () => JSON.stringify(await railOrder(page)) === JSON.stringify(await apiOrder(page)), {
                message: 'the rail and the API agree after a folder drag',
            })
            .toBe(true);
        await expectDragFullyEnded(page, 'after dragging a folder');
        await page.screenshot({ path: `${SHOT}/08-folder-dragged.png` });
    });

    test('mouse user: the slot below a folder keeps the server out of the folder', async () => {
        test.setTimeout(120000);
        // "Drag a server under a group and it places it in that group instead" —
        // every drop on a folder used to mean "join it", so there was no way to
        // say "sit under this folder, outside it".
        const folder = await ensureFolder(page);
        await setFolderExpanded(page, folder.gid, false);

        const groups = await groupByServer(page);
        const loose = (await railOrder(page)).filter((id) => !groups[id]);
        const source = loose.find((id) => !folder.members.includes(id));
        expect(source, 'need a loose server to drag under the folder').toBeTruthy();

        const gapSel = `#server-list > .server-drop-gap[data-after-group="${folder.gid}"]`;
        await expect(page.locator(gapSel), 'the slot below the folder exists').toHaveCount(1);
        const gap = await centerOf(page, gapSel);
        const from = await centerOf(page, `.server-icon[data-id="${source}"]`);

        await startMouseDrag(page, from, gap);
        await page.mouse.up();

        await expect
            .poll(async () => (await groupByServer(page))[source!], {
                message: 'a drop in the slot below a folder must not join it',
            })
            .toBeNull();
        await expect
            .poll(async () => {
                const o = await apiOrder(page);
                const last = folder.members[folder.members.length - 1];
                return o.indexOf(source!) - o.indexOf(last);
            }, { message: 'the server lands directly under the folder' })
            .toBe(1);
        await expectDragFullyEnded(page, 'after dropping under a folder');
    });

    test('mouse user: an expanded folder has slots between its members', async () => {
        test.setTimeout(120000);
        // "Inside an opened group we don't have the same in between space the
        // groupless servers have" — the members had no slots at all, so nothing
        // could be placed between two of them.
        const folder = await ensureFolder(page);
        await setFolderExpanded(page, folder.gid, true);
        expect(folder.members.length).toBeGreaterThanOrEqual(2);

        const head = folder.members[0];
        const gapSel =
            `#server-list .server-group[data-group-id="${folder.gid}"] ` +
            `.server-drop-gap.inside[data-after-server="${head}"]`;
        await expect(page.locator(gapSel), 'each member is followed by a slot inside the folder').toHaveCount(1);

        const groups = await groupByServer(page);
        const loose = (await railOrder(page)).filter((id) => !groups[id]);
        const source = loose.find((id) => !folder.members.includes(id));
        expect(source, 'need a loose server to drop between the members').toBeTruthy();

        const gap = await centerOf(page, gapSel);
        const from = await centerOf(page, `.server-icon[data-id="${source}"]`);
        await startMouseDrag(page, from, gap);
        await page.mouse.up();

        await expect
            .poll(async () => (await groupByServer(page))[source!], {
                message: 'a drop on an inner slot joins the folder',
            })
            .toBe(folder.gid);
        await expect
            .poll(async () => {
                const o = await apiOrder(page);
                return o.indexOf(source!) - o.indexOf(head);
            }, { message: 'the server sits between the two members' })
            .toBe(1);
        await expectDragFullyEnded(page, 'after dropping into a folder slot');
    });

    test('mouse user: the slot above the first entry drops something at the very top', async () => {
        test.setTimeout(120000);
        // A folder at the top of the rail left nothing above it to drop onto, so
        // "put this above the folder" had no slot to mean it.
        const folder = await ensureFolder(page);
        await setFolderExpanded(page, folder.gid, false);

        const groups = await groupByServer(page);
        const loose = (await railOrder(page)).filter((id) => !groups[id]);
        const source = loose[loose.length - 1];
        expect(source, 'need a loose server to move to the top').toBeTruthy();

        const gapSel = '#server-list > .server-drop-gap.top';
        await expect(page.locator(gapSel), 'the rail has a slot above its first entry').toHaveCount(1);
        const gap = await centerOf(page, gapSel);
        const from = await centerOf(page, `.server-icon[data-id="${source}"]`);

        await startMouseDrag(page, from, gap);
        await page.mouse.up();

        await expect
            .poll(async () => (await apiOrder(page))[0], {
                message: 'the server dropped above everything is first in the rail order',
            })
            .toBe(source);
        await expect.poll(async () => (await railOrder(page))[0]).toBe(source);
        await expectDragFullyEnded(page, 'after dropping at the very top');
    });

    test('mouse user: DM conversations have in-between slots and reorder through them', async () => {
        test.setTimeout(120000);
        // The DM sidebar rendered rows only, so a conversation could be dropped
        // onto another row's top/bottom half but never *between* two of them.
        // Reaching two real conversations needs a second account, and this one
        // has none — the sidebar renders straight from `dmConversations`, so
        // seeding that is enough to exercise the slots themselves.
        await reloadRail(page);
        // This account has no real conversations, and the sidebar refetches them
        // on heartbeat/WS events — which would empty the seeded list mid-drag and
        // rebuild the sidebar under the drop. Answer that one endpoint from the
        // seed, so every refresh keeps the same three rows.
        await page.evaluate(() => {
            const seed = ['dmA:Alpha', 'dmB:Beta', 'dmC:Gamma'].map((pair) => {
                const [id, name] = pair.split(':');
                return { dm_channel_id: id, other_user_id: 'u_' + id, other_username: name };
            });
            const realFetch = window.fetch.bind(window);
            window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
                const url = typeof input === 'string' ? input : (input as Request).url || String(input);
                if (url.indexOf('/api/dm/conversations') !== -1) {
                    return Promise.resolve(new Response(JSON.stringify(seed), {
                        status: 200, headers: { 'Content-Type': 'application/json' },
                    }));
                }
                return realFetch(input, init);
            };
            // `dmConversations` is a top-level `var`, so it is a window property
            // — but seeding through `window` is what the app reads, and the
            // refetch above keeps it that way.
            (window as any).dmConversations.length = 0;
            seed.forEach((c) => (window as any).dmConversations.push(c));
            (window as any).renderDmSidebar();
        });

        // Read the list shape in one go: three rows, a slot above the first and
        // one after every row.
        await expect
            .poll(async () => page.evaluate(() => {
                const gaps = Array.from(document.querySelectorAll('#dm-list .dm-drop-gap'));
                return [
                    document.querySelectorAll('#dm-list .dm-item[data-dm-id]').length,
                    gaps.length,
                    gaps.filter((g) => g.classList.contains('top')).length,
                ].join(':');
            }), { message: 'three rows, a slot above them and one after each' })
            .toBe('3:4:1');

        // Measured in-page: the locator API reports no box for these thin slots.
        const dmCenters = async (gapId: string, rowId: string) => await page.evaluate(([g, r]) => {
            const center = (sel: string) => {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (!el) throw new Error('no element for ' + sel);
                const b = el.getBoundingClientRect();
                return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
            };
            return {
                gap: center(`#dm-list .dm-drop-gap[data-after-dm="${g}"]`),
                row: center(`#dm-list .dm-item[data-dm-id="${r}"]`),
            };
        }, [gapId, rowId]);

        // The slot right after the dragged row must not reorder anything — the
        // anchor disappears with the row, which used to append it instead.
        const selfSlot = await dmCenters('dmC', 'dmC');
        await startMouseDrag(page, selfSlot.row, selfSlot.gap);
        await page.mouse.up();
        await expect
            .poll(async () => page.evaluate(() =>
                (window as any).dmConversations.map((c: any) => c.dm_channel_id).join(',')), {
                message: 'a drop in the row\'s own slot leaves the order alone',
            })
            .toBe('dmA,dmB,dmC');

        const { gap, row: from } = await dmCenters('dmA', 'dmC');
        await startMouseDrag(page, from, gap);

        const mid = await page.evaluate(() => ({
            listDragging: document.getElementById('dm-list')!.classList.contains('dm-list-dragging'),
            activeGaps: document.querySelectorAll('#dm-list .dm-drop-gap.drop-active').length,
        }));
        expect(mid.listDragging, 'the DM list marks itself as dragging so the slots show').toBe(true);
        expect(mid.activeGaps, 'the slot under the pointer highlights').toBeGreaterThan(0);

        await page.mouse.up();

        await expect
            .poll(async () => page.evaluate(() =>
                (window as any).dmConversations.map((c: any) => c.dm_channel_id).join(',')), {
                message: 'the conversation dropped between the first two rows',
            })
            .toBe('dmA,dmC,dmB');
        await expect
            .poll(async () => page.evaluate(() =>
                Array.from(document.querySelectorAll('#dm-list .dm-item[data-dm-id]'))
                    .map((el) => (el as HTMLElement).dataset.dmId).join(',')), {
                message: 'and the sidebar redraws in the new order',
            })
            .toBe('dmA,dmC,dmB');
    });
});
