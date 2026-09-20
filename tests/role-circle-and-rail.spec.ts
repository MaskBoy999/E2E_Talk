import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'static', 'style.css'), 'utf8');
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'static', 'chat.js'), 'utf8');
// The tap-label code is the last block of chat.js.
const ROLE_SNIPPET = CHAT_JS.slice(CHAT_JS.indexOf('// === Role circle tap label ==='));

test('role circle: tap opens the role name, tap elsewhere closes it', async ({ page }) => {
    await page.setContent(
        '<div id="member-list" class="member-list">' +
        '<div class="member-item"><span class="role-circle" data-role-name="Moderator" title="Moderator" style="background:#ff0055"></span>' +
        '<span class="member-name">Alice</span></div>' +
        '<div class="member-item"><span class="role-circle" data-role-name="Helper" style="background:#00ff88"></span>' +
        '<span class="member-name">Bob</span></div>' +
        '</div>'
    );
    await page.addStyleTag({ content: CSS });
    await page.addScriptTag({ content: ROLE_SNIPPET });

    await expect(page.locator('.role-circle-label')).toHaveCount(0);

    // Tap 1 → the role name appears and the tapped circle is ringed.
    await page.locator('.role-circle').first().click();
    await expect(page.locator('.role-circle-label')).toHaveText('Moderator');
    await expect(page.locator('.role-circle').first()).toHaveClass(/role-circle-open/);
    const placement = await page.evaluate(() => {
        const c = document.querySelector('.role-circle')!.getBoundingClientRect();
        const l = document.querySelector('.role-circle-label')!.getBoundingClientRect();
        return { clearOfCircle: l.left >= c.right, withinViewport: l.right <= window.innerWidth + 1 };
    });
    expect(placement.clearOfCircle, 'label does not cover the tapped circle').toBe(true);
    expect(placement.withinViewport, 'label stays on screen').toBe(true);

    // Tapping another circle re-points the same label instead of stacking them.
    await page.locator('.role-circle').nth(1).click();
    await expect(page.locator('.role-circle-label')).toHaveCount(1);
    await expect(page.locator('.role-circle-label')).toHaveText('Helper');

    // A tap anywhere off the circle dismisses it.
    await page.mouse.click(600, 400);
    await expect(page.locator('.role-circle-label')).toHaveCount(0);
    await expect(page.locator('.role-circle.role-circle-open')).toHaveCount(0);

    // Escape dismisses it too.
    await page.locator('.role-circle').first().click();
    await expect(page.locator('.role-circle-label')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.role-circle-label')).toHaveCount(0);

    // Desktop keeps the original 10px dot.
    const deskBox = (await page.locator('.role-circle').first().boundingBox())!;
    expect(deskBox.width).toBe(10);
    expect(deskBox.height).toBe(10);
});

test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('role circle is bigger on a phone viewport and still opens the label', async ({ page }) => {
        await page.setContent(
            '<div id="member-list" class="member-list">' +
            '<div class="member-item"><span class="role-circle" data-role-name="Moderator" title="Moderator" style="background:#ff0055"></span>' +
            '<span class="member-name">Alice</span></div>' +
            '</div>'
        );
        await page.addStyleTag({ content: CSS });
        await page.addScriptTag({ content: ROLE_SNIPPET });

        const box = (await page.locator('.role-circle').boundingBox())!;
        expect(box.width).toBe(15);
        expect(box.height).toBe(15);

        await page.locator('.role-circle').click();
        await expect(page.locator('.role-circle-label')).toHaveText('Moderator');
        const placement = await page.evaluate(() => {
            const c = document.querySelector('.role-circle')!.getBoundingClientRect();
            const l = document.querySelector('.role-circle-label')!.getBoundingClientRect();
            return { clearOfCircle: l.left >= c.right, withinViewport: l.right <= window.innerWidth + 1 };
        });
        expect(placement.clearOfCircle).toBe(true);
        expect(placement.withinViewport).toBe(true);
    });
});

test('server rail: entries sit close at rest and spread out while dragging', async ({ page }) => {
    await page.setContent(
        '<div class="server-strip"><div id="server-list" class="server-list">' +
        '<div class="server-icon">A</div><div class="server-drop-gap"></div>' +
        '<div class="server-icon">B</div><div class="server-drop-gap"></div>' +
        '<div class="server-icon">C</div>' +
        '</div></div>'
    );
    await page.addStyleTag({ content: CSS });
    await page.waitForTimeout(500); // let any first-paint transitions settle

    const metrics = () =>
        page.evaluate(() => {
            const icons = Array.from(document.querySelectorAll('#server-list .server-icon')) as HTMLElement[];
            const mid = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
            const gap = document.querySelector('#server-list .server-drop-gap') as HTMLElement;
            const r = gap.getBoundingClientRect();
            return { ab: mid(icons[1]) - mid(icons[0]), bc: mid(icons[2]) - mid(icons[1]), gapHeight: r.height };
        });

    const rest = await metrics();
    await page.evaluate(() => document.getElementById('server-list')!.classList.add('server-list-dragging'));
    await page.waitForTimeout(400);
    const dragging = await metrics();
    await page.evaluate(() => document.getElementById('server-list')!.classList.remove('server-list-dragging'));
    await page.waitForTimeout(400);
    const back = await metrics();

    // No always-on flex gap: the icons are one icon-height + a 10px slot apart.
    expect(rest.ab).toBeLessThan(60);
    expect(rest.gapHeight).toBeLessThan(8);
    // Picking a server up opens the rail…
    expect(dragging.ab).toBeGreaterThan(rest.ab + 4);
    expect(dragging.gapHeight).toBeGreaterThan(rest.gapHeight);
    // …and letting go puts it back exactly as it was.
    expect(back.ab).toBeCloseTo(rest.ab, 1);
    expect(back.gapHeight).toBeCloseTo(rest.gapHeight, 1);
});
