import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASSWORD = 'testpass1234';
const SHOT = 'test-results/role-tiers';

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

async function createServer(page: Page, name: string): Promise<string> {
    await page.waitForSelector('#add-server-btn', { timeout: 20000 });
    await page.click('#add-server-btn');
    await page.waitForSelector('#choice-create-server', { state: 'visible', timeout: 10000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 10000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]:not(.add-server)', { timeout: 25000 });
    await page.locator('.server-icon[data-id]:not(.add-server)').first().click();
    await page.waitForTimeout(2000);
    const sid = await page.evaluate(() =>
        document.querySelector('.server-icon[data-id]:not(.add-server)')?.getAttribute('data-id') || '');
    expect(sid).toBeTruthy();
    return sid;
}

async function api(page: Page, path: string, init: any = {}) {
    return await page.evaluate(async ([p, i]) => {
        const res = await fetch(p as string, Object.assign({
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + localStorage.getItem('token'),
            },
        }, i || {}));
        let body: any = null;
        try { body = await res.json(); } catch (_) { /* empty */ }
        return { status: res.status, body };
    }, [path, init]);
}

/** Re-render the roles panel from the server without reopening settings. */
async function refreshRoles(page: Page, sid: string) {
    await page.evaluate(async (s) => {
        const SR = (window as any).ServerRoles;
        await SR.load(s);
        SR.renderRoleList();
    }, sid);
    await page.waitForTimeout(250);
}

async function openRoles(page: Page, sid: string) {
    await page.click('#server-settings-btn');
    await page.waitForSelector('#server-settings-modal', { state: 'visible', timeout: 15000 });
    await page.waitForSelector('#roles-list .role-tier-group', { timeout: 20000 });
    await refreshRoles(page, sid);
}

async function roleIds(page: Page, sid: string): Promise<Record<string, string>> {
    const r = await api(page, `/api/servers/${sid}/roles`);
    expect(r.status).toBe(200);
    const map: Record<string, string> = {};
    (r.body.roles as any[]).forEach((x) => { if (!x.is_everyone) map[x.name] = x.id; });
    return map;
}

/** Force a known layout so each test starts from the same tier structure. */
async function setLayout(page: Page, sid: string, positions: Record<string, number>) {
    const ids = await roleIds(page, sid);
    const ordered = Object.keys(positions).map((name) => ({ id: ids[name], position: positions[name] }));
    const res = await api(page, `/api/servers/${sid}/roles/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ ordered_ids: ordered }),
    });
    expect(res.status).toBe(200);
    await refreshRoles(page, sid);
}

/** Server-side tier view: ordered strongest-first, with encryption intact. */
async function apiTiers(page: Page, sid: string) {
    const r = await api(page, `/api/servers/${sid}/roles`);
    expect(r.status).toBe(200);
    const roles = (r.body.roles as any[]).filter((x) => !x.is_everyone);
    const byPos: Record<string, any[]> = {};
    roles.forEach((x) => {
        const k = String(x.position);
        (byPos[k] = byPos[k] || []).push(x);
    });
    return Object.keys(byPos)
        .map(Number)
        .sort((a, b) => b - a)
        .map((p) => ({
            position: p,
            names: byPos[String(p)].map((x) => x.name).sort(),
            encOk: byPos[String(p)].every((x) => !!x.encrypted_name && !!x.name_nonce),
        }));
}

/** What the user actually sees in the roles list. */
async function domTiers(page: Page) {
    return await page.evaluate(() => {
        const out: any[] = [];
        document.querySelectorAll('#roles-list .role-tier-group:not(.role-tier-owner)').forEach((g) => {
            const el = g as HTMLElement;
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            out.push({
                label: el.querySelector('.role-tier-label')?.textContent || '',
                names: Array.from(el.querySelectorAll('.role-row-name')).map((n) => n.textContent || ''),
                borderWidth: parseFloat(cs.borderTopWidth),
                borderColor: cs.borderTopColor,
                managed: el.dataset.managed,
                tierPos: el.dataset.tierPos,
                rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            });
        });
        return out;
    });
}

function alphaOf(rgb: string): number {
    const m = rgb.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return parts.length >= 4 ? parts[3] : 1;
}

async function createRoleUI(page: Page, name: string) {
    await page.click('#create-role-btn');
    await page.waitForTimeout(900);
    await page.fill('#role-name-input', name);
    await page.click('#save-role-btn');
    await page.waitForTimeout(1000);
}

async function selectRole(page: Page, name: string) {
    await page.locator('#roles-list .role-row', { hasText: name }).first().click();
    await page.waitForSelector('#role-editor', { state: 'visible', timeout: 8000 });
    await page.waitForTimeout(200);
}

function tierGroups(page: Page) {
    return page.locator('#roles-list .role-tier-group:not(.role-tier-owner)');
}

async function clickArrow(page: Page, dir: 'up' | 'down') {
    await page.click(dir === 'up' ? '#role-move-up' : '#role-move-down');
    await page.waitForTimeout(1200);
}

/** HTML5 drag of a role row: 'join' a tier, or drop on a strip to add a tier. */
async function dragRoleTo(page: Page, roleName: string, tierIndex: number, zone: 'above' | 'join') {
    const src = page.locator('#roles-list .role-row', { hasText: roleName }).first();
    const target = zone === 'join'
        ? tierGroups(page).nth(tierIndex)
        : page.locator('#roles-list .role-drop-gap:not(.role-drop-gap-tail)').nth(tierIndex);
    const box = await target.boundingBox();
    if (!box) throw new Error('drag target has no box');
    await src.dragTo(target);
    await page.waitForTimeout(1500);
}

/** Long-press + touch-drag a row onto a tier (synthetic TouchEvents). */
async function touchDragRoleTo(page: Page, roleName: string, tierIndex: number, zone: 'above' | 'join' | 'below') {
    await page.evaluate(async ([name, idx, z]) => {
        const rows = Array.from(document.querySelectorAll('#roles-list .role-row')) as HTMLElement[];
        const row = rows.find((r) => (r.querySelector('.role-row-name')?.textContent || '') === name);
        const tiers = Array.from(document.querySelectorAll('#roles-list .role-tier-group:not(.role-tier-owner)')) as HTMLElement[];
        const gaps = Array.from(document.querySelectorAll('#roles-list .role-drop-gap:not(.role-drop-gap-tail)')) as HTMLElement[];
        const target = z === 'join' ? tiers[idx as number] : gaps[idx as number];
        if (!row || !target) throw new Error('missing drag endpoints');
        const r = row.getBoundingClientRect();
        const t = target.getBoundingClientRect();
        const sx = r.left + r.width / 2;
        const sy = r.top + r.height / 2;
        const tx = t.left + t.width / 2;
        const ty = t.top + t.height / 2;

        function ev(type: string, x: number, y: number) {
            const touch = new Touch({
                identifier: 1, target: row!, clientX: x, clientY: y,
                pageX: x, pageY: y, screenX: x, screenY: y,
                radiusX: 6, radiusY: 6, force: 1,
            });
            const active = type === 'touchend' ? [] : [touch];
            return new TouchEvent(type, {
                bubbles: true, cancelable: true,
                touches: active, targetTouches: active, changedTouches: [touch],
            });
        }
        row.dispatchEvent(ev('touchstart', sx, sy));
        await new Promise((res) => setTimeout(res, 500));      // longer than the 320ms long-press
        row.dispatchEvent(ev('touchmove', tx, ty));
        await new Promise((res) => setTimeout(res, 60));
        row.dispatchEvent(ev('touchend', tx, ty));
        await new Promise((res) => setTimeout(res, 1500));
    }, [roleName, tierIndex, zone]);
    await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------

test.describe.serial('Server role tiers', () => {
    let ctx: BrowserContext;
    let page: Page;
    let sid = '';
    // The drag/join tests need every tier on screen, so they disable the list's
    // 190px scroll clamp. The auto-scroll test removes that override again.
    let noScrollStyle: any = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(180000);
        ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        page = await ctx.newPage();
        await register(page, unique('tier_owner'));
        sid = await createServer(page, 'Tier Lab');
        await openRoles(page, sid);
        // The roles list is a 190px scroll container in the real UI. For drag
        // targeting we let it grow so every tier is on screen at once.
        noScrollStyle = await page.addStyleTag({ content: '#roles-list{max-height:none !important;overflow:visible !important;}' });
        // Created through the UI so the names are really encrypted.
        await createRoleUI(page, 'Alpha');
        await createRoleUI(page, 'Beta');
        await createRoleUI(page, 'Gamma');
    });

    test.afterAll(async () => { await ctx?.close(); });

    test('each role gets its own outlined tier', async () => {
        test.setTimeout(120000);
        await setLayout(page, sid, { Alpha: 30, Beta: 20, Gamma: 10 });

        const tiers = await domTiers(page);
        expect(tiers.length).toBe(3);
        expect(tiers.map((t) => t.names.join('+'))).toEqual(['Alpha', 'Beta', 'Gamma']);
        for (const t of tiers) {
            expect(t.label).toMatch(/^Tier \d+$/);
            expect(t.names.length).toBe(1);
            expect(t.borderWidth).toBeGreaterThanOrEqual(1);
            expect(alphaOf(t.borderColor)).toBeGreaterThan(0.05);
            expect(t.rect.h).toBeGreaterThan(20);
        }
        await page.screenshot({ path: `${SHOT}/01-three-single-role-tiers.png` });

        // A brand new role becomes its own tier instead of sharing one.
        await createRoleUI(page, 'Delta');
        const after = await domTiers(page);
        expect(after.length).toBe(4);
        expect(after[3].names).toEqual(['Delta']);
        await page.screenshot({ path: `${SHOT}/02-new-role-own-tier.png` });

        // Put it back to three roles for the following tests.
        const ids = await roleIds(page, sid);
        await api(page, `/api/servers/${sid}/roles/${ids['Delta']}`, { method: 'DELETE' });
        await setLayout(page, sid, { Alpha: 30, Beta: 20, Gamma: 10 });
    });

    test('arrow buttons merge a lone role into a tier and peel a shared role back out', async () => {
        test.setTimeout(120000);
        await setLayout(page, sid, { Alpha: 30, Beta: 20, Gamma: 10 });

        // Move INTO the tier above: Beta is alone, up should join Alpha.
        await selectRole(page, 'Beta');
        await clickArrow(page, 'up');
        let tiers = await apiTiers(page, sid);
        expect(tiers.length).toBe(2);
        expect(tiers[0].names).toEqual(['Alpha', 'Beta']);
        expect(tiers[0].encOk).toBe(true);          // encrypted names survived
        await page.screenshot({ path: `${SHOT}/03-arrow-merge-into-tier.png` });

        // Move OUT again: Beta now shares a tier, up should give it its own tier.
        await selectRole(page, 'Beta');
        await clickArrow(page, 'up');
        tiers = await apiTiers(page, sid);
        expect(tiers.length).toBe(3);
        expect(tiers[0].names).toEqual(['Beta']);
        expect(tiers[1].names).toEqual(['Alpha']);
        await page.screenshot({ path: `${SHOT}/04-arrow-peel-out.png` });

        // A lone role already sitting in the weakest tier has nowhere weaker to
        // go: the arrow is a no-op instead of inventing an empty tier.
        await selectRole(page, 'Gamma');
        await clickArrow(page, 'down');
        tiers = await apiTiers(page, sid);
        expect(tiers.length).toBe(3);
        expect(tiers[2].names).toEqual(['Gamma']);

        // A role that SHARES a tier peels out into its own tier when pushed away.
        await setLayout(page, sid, { Alpha: 30, Beta: 20, Gamma: 20 });
        expect((await apiTiers(page, sid)).length).toBe(2);
        await page.screenshot({ path: `${SHOT}/05-shared-tier-before-peel.png` });
        await selectRole(page, 'Gamma');
        await clickArrow(page, 'down');
        tiers = await apiTiers(page, sid);
        expect(tiers.length).toBe(3);
        expect(tiers[1].names).toEqual(['Beta']);
        expect(tiers[2].names).toEqual(['Gamma']);
        expect(tiers.every((t) => t.encOk)).toBe(true);   // encryption intact after reorders
        await page.screenshot({ path: `${SHOT}/06-arrow-peel-shared-down.png` });

        // And a lone role moves back IN to the tier above.
        await selectRole(page, 'Gamma');
        await clickArrow(page, 'up');
        tiers = await apiTiers(page, sid);
        expect(tiers.length).toBe(2);
        expect(tiers[1].names).toEqual(['Beta', 'Gamma']);

        // The DOM agrees with the server.
        const dom = await domTiers(page);
        expect(dom.length).toBe(2);
        expect(dom.every((t) => t.managed === '1')).toBe(true);
    });

    test('drag a role onto a tier to join it, into the gap to split it, and drag whole tiers', async () => {
        test.setTimeout(120000);
        await setLayout(page, sid, { Alpha: 30, Beta: 20, Gamma: 10 });

        // Drop on the middle of a tier -> join it (3 tiers become 2).
        await dragRoleTo(page, 'Gamma', 1, 'join');
        let tiers = await apiTiers(page, sid);
        expect(tiers.length).toBe(2);
        expect(tiers[1].names).toEqual(['Beta', 'Gamma']);
        expect(tiers[1].encOk).toBe(true);
        await page.screenshot({ path: `${SHOT}/07-drag-join-tier.png` });

        // Drop on the top edge of a tier -> a new tier above it (2 tiers become 3).
        await dragRoleTo(page, 'Gamma', 0, 'above');
        tiers = await apiTiers(page, sid);
        expect(tiers.length).toBe(3);
        expect(tiers[0].names).toEqual(['Gamma']);
        expect(tiers[1].names).toEqual(['Alpha']);
        await page.screenshot({ path: `${SHOT}/08-drag-new-tier-above.png` });

        // Drag the whole second tier (its label) onto the first tier.
        const label = tierGroups(page).nth(1).locator('.role-tier-label');
        await label.dragTo(tierGroups(page).nth(0));
        await page.waitForTimeout(1500);
        tiers = await apiTiers(page, sid);
        expect(tiers.length).toBe(2);
        await page.screenshot({ path: `${SHOT}/09-drag-whole-tier.png` });
    });

    test('context-menu section headers render disabled and cannot be clicked', async () => {
        test.setTimeout(120000);
        // The member right-click menu lists "— Role —" as a section header. It
        // must be greyed out and inert instead of looking like a dead option.
        const openMenu = async () => page.evaluate(() => {
            (window as any).__picked = (window as any).__picked || 0;
            (window as any).showContextMenuAt(new MouseEvent('contextmenu', { bubbles: true }), [
                { label: '\u2014 Role \u2014', disabled: true },
                { label: 'No role (@everyone)', action: function () { (window as any).__picked++; } },
            ]);
        });
        await page.evaluate(() => { (window as any).__picked = 0; });

        await openMenu();
        const header = page.locator('.channel-context-menu .context-menu-item', { hasText: 'Role' }).first();
        await expect(header).toHaveClass(/disabled/);
        await expect(header).toHaveCSS('cursor', 'default');
        await expect(header).toHaveCSS('pointer-events', 'none');
        await page.screenshot({ path: `${SHOT}/12-disabled-menu-header.png` });
        // Clicking it (forced past the pointer-events guard) must not fire anything.
        await header.click({ force: true });
        expect(await page.evaluate(() => (window as any).__picked)).toBe(0);

        // A real option in the same menu still works.
        await openMenu();
        await page.locator('.channel-context-menu .context-menu-item', { hasText: '@everyone' }).first().click();
        expect(await page.evaluate(() => (window as any).__picked)).toBe(1);
    });

    test('holding a drag near the list edges auto-scrolls the roles list', async () => {
        test.setTimeout(180000);
        // Restore the real 190px scroll container for this test.
        if (noScrollStyle) { await noScrollStyle.evaluate((el: any) => el.remove()); noScrollStyle = null; }

        const sid2 = await createServer(page, 'Scroll Lab');
        for (let i = 0; i < 10; i++) {
            const res = await api(page, `/api/servers/${sid2}/roles`, {
                method: 'POST',
                body: JSON.stringify({ name: 'Scroll' + i, color: '#4fc3f7', permissions: 0, position: 10 * (10 - i) }),
            });
            expect(res.status).toBe(200);
        }
        await page.click('#server-settings-btn');
        await page.waitForSelector('#server-settings-modal', { state: 'visible' });
        await refreshRoles(page, sid2);

        const scrollable = await page.evaluate(() => {
            const el = document.getElementById('roles-list') as HTMLElement;
            return {
                overflow: getComputedStyle(el).overflowY,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                rows: el.querySelectorAll('.role-tier-group').length,
            };
        });
        expect(scrollable.rows).toBe(10);
        expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight + 20);

        const run = async (edge: 'top' | 'bottom', ms: number) => await page.evaluate(async ([which, wait]) => {
            const el = document.getElementById('roles-list') as HTMLElement;
            const row = el.querySelector('.role-row') as HTMLElement;
            const dt = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            const rect = el.getBoundingClientRect();
            const cy = which === 'bottom' ? rect.bottom - 3 : rect.top + 3;
            const before = el.scrollTop;
            // Re-assert the pointer each frame window so the loop keeps scrolling.
            for (let i = 0; i < 12; i++) {
                document.dispatchEvent(new DragEvent('dragover', {
                    bubbles: true, cancelable: true, dataTransfer: dt,
                    clientX: rect.left + rect.width / 2, clientY: cy,
                }));
                await new Promise((r) => setTimeout(r, wait / 12));
            }
            const after = el.scrollTop;
            row.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
            return { before, after };
        }, [edge, ms] as [string, number]);

        await page.evaluate(() => { (document.getElementById('roles-list') as HTMLElement).scrollTop = 0; });
        const down = await run('bottom', 700);
        expect(down.after, 'dragging at the bottom edge scrolls down').toBeGreaterThan(down.before);
        await page.screenshot({ path: `${SHOT}/13-autoscroll-down.png` });

        const up = await run('top', 700);
        expect(up.after, 'dragging at the top edge scrolls back up').toBeLessThan(up.before);

        // Releasing stops the scrolling.
        const rest = await page.evaluate(async () => {
            const el = document.getElementById('roles-list') as HTMLElement;
            const at = el.scrollTop;
            await new Promise((r) => setTimeout(r, 400));
            return { at, later: el.scrollTop };
        });
        expect(rest.later).toBe(rest.at);
    });

    test('touch long-press drag moves a role between tiers on a phone viewport', async ({ browser }) => {
        test.setTimeout(180000);
        const mctx = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block',
            viewport: { width: 390, height: 780 },
            hasTouch: true,
            isMobile: true,
            // Reuse the owner's session so the phone sees the same account.
            storageState: await ctx.storageState(),
        });
        const mpage = await mctx.newPage();
        await mpage.goto(`${BASE}/index.html`);
        await mpage.waitForSelector(`.server-icon[data-id="${sid}"]`, { timeout: 30000 });
        await mpage.click(`.server-icon[data-id="${sid}"]`);
        await mpage.waitForTimeout(2500);
        await openRoles(mpage, sid);
        await mpage.addStyleTag({ content: '#roles-list{max-height:none !important;overflow:visible !important;}' });
        await setLayout(mpage, sid, { Alpha: 30, Beta: 20, Gamma: 10 });

        await mpage.screenshot({ path: `${SHOT}/10-mobile-before-touch-drag.png` });
        await touchDragRoleTo(mpage, 'Gamma', 0, 'join');
        const tiers = await apiTiers(mpage, sid);
        expect(tiers.length).toBe(2);
        expect(tiers[0].names).toEqual(['Alpha', 'Gamma']);
        await mpage.screenshot({ path: `${SHOT}/11-mobile-after-touch-drag.png` });

        // A long-press must not fire the row click (no selection side effects) and
        // the tier list must still be intact afterwards.
        const dom = await domTiers(mpage);
        expect(dom.length).toBe(2);
        await mctx.close();
    });
});
