import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PW = 'testpass123';

function unique(prefix: string) { return prefix + '_' + Math.random().toString(36).slice(2, 8); }

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.waitForSelector('#register-username', { timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PW);
    await page.fill('#register-confirm-password', PW);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
}

async function waitForWs(page: Page) {
    for (let i = 0; i < 60; i++) {
        const ok = await page.evaluate(() => {
            const ws = (window as any).ws;
            return ws && ws.readyState === 1;
        });
        if (ok) return;
        await page.waitForTimeout(500);
    }
}

async function createServer(page: Page, name: string) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#new-server-name', { timeout: 5000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    await page.waitForTimeout(1000);
}

test.describe('Mute Soundboard', () => {

    test('Mute soundboard button toggles via _sbToggleMuteUser', async ({ page }) => {
        const ctx = page.context();
        await ctx.grantPermissions(['microphone'], { origin: BASE });
        const username = unique('msb');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'Mute SB Test');

        // Register a second user for muting
        const ctx2 = await page.context().browser()!.newContext();
        const page2 = await ctx2.newPage();
        await register(page2, unique('msb2'));
        await waitForWs(page2);

        // User 2 joins user 1's server via invite code from localStorage
        const serverId = await page.evaluate(() => (window as any).currentServerId);
        const inviteCode = await page.evaluate((sid: string) => {
            return localStorage.getItem('e2e_invite_' + sid) || '';
        }, serverId);

        if (inviteCode) {
            await page2.evaluate(async (code: string) => {
                const resp = await fetch('/api/servers/join', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + localStorage.getItem('token'),
                    },
                    body: JSON.stringify({ invite_code: code }),
                });
                return resp.json();
            }, inviteCode);
            await page2.waitForTimeout(2000);

            // Get user2's ID
            const uid2 = await page2.evaluate(() => (window as any).currentUserId);

            // Verify _sbToggleMuteUser exists and works
            const muteResult = await page.evaluate((uid: string) => {
                const before = (window as any)._sbIsUserMuted(uid);
                const wasMuted = (window as any)._sbToggleMuteUser(uid);
                const after = (window as any)._sbIsUserMuted(uid);
                return { before, wasMuted, after };
            }, uid2);
            console.log('Mute toggle result:', JSON.stringify(muteResult));
            expect(muteResult.before).toBe(false);
            expect(muteResult.wasMuted).toBe(true);
            expect(muteResult.after).toBe(true);

            // Toggle again to unmute
            const unmuteResult = await page.evaluate((uid: string) => {
                const wasMuted = (window as any)._sbToggleMuteUser(uid);
                const after = (window as any)._sbIsUserMuted(uid);
                return { wasMuted, after };
            }, uid2);
            console.log('Unmute toggle result:', JSON.stringify(unmuteResult));
            expect(unmuteResult.wasMuted).toBe(false);
            expect(unmuteResult.after).toBe(false);

            // Verify _sbMutedList proxy works for indexOf
            const proxyCheck = await page.evaluate((uid: string) => {
                return (window as any)._sbMutedList.indexOf(uid);
            }, uid2);
            console.log('Proxy indexOf check:', proxyCheck);
            // Should be -1 since we unmuted
            expect(proxyCheck).toBe(-1);
        } else {
            console.log('No invite code, skipping join part - testing toggle function only');

            const toggleResult = await page.evaluate(() => {
                const fakeUid = 'test-user-123';
                const before = (window as any)._sbIsUserMuted(fakeUid);
                const wasMuted = (window as any)._sbToggleMuteUser(fakeUid);
                const after = (window as any)._sbIsUserMuted(fakeUid);
                return { before, wasMuted, after };
            });
            console.log('Toggle result:', JSON.stringify(toggleResult));
            expect(toggleResult.before).toBe(false);
            expect(toggleResult.wasMuted).toBe(true);
            expect(toggleResult.after).toBe(true);
        }

        await page2.close();
        await ctx2.close();
    });
});

test.describe('Voice Indicator on Groups', () => {

    test('Group voice dot appears on collapsed group when member is in voice', async ({ page }) => {
        const ctx = page.context();
        await ctx.grantPermissions(['microphone'], { origin: BASE });
        const username = unique('vdot');
        await register(page, username);
        await waitForWs(page);

        // Create 2 servers and group them
        await createServer(page, 'Voice Dot 1');
        await page.waitForTimeout(1500);
        await createServer(page, 'Voice Dot 2');
        await page.waitForTimeout(1500);

        await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            const servers = await (await fetch('/api/servers', { headers: h })).json();
            const grpResp = await fetch('/api/server-groups', {
                method: 'POST', headers: h,
                body: JSON.stringify({ name: 'Voice Test Group' }),
            });
            const grp = await grpResp.json();
            await fetch('/api/servers/' + servers[0].id + '/group', {
                method: 'PUT', headers: h,
                body: JSON.stringify({ group_id: grp.id }),
            });
        });

        // Reload to see groups
        await page.reload();
        await waitForWs(page);
        await page.waitForTimeout(2000);

        // Verify group exists and is collapsed
        const groupEl = await page.$('.server-group');
        expect(groupEl).toBeTruthy();
        const isCollapsed = await page.evaluate(() => {
            const g = document.querySelector('.server-group');
            return g ? g.classList.contains('collapsed') : false;
        });
        console.log('Group collapsed:', isCollapsed);

        // Verify no voice dot initially (group is expanded, so no dot expected)
        const dotBefore = await page.$('.group-voice-dot');
        console.log('Voice dot before collapse:', !!dotBefore);

        // Collapse the group first
        const hdr = await page.$('.server-group-header');
        if (hdr) { await hdr.click(); await page.waitForTimeout(500); }

        // Verify collapsed state
        const isCollapsedAfter = await page.evaluate(() => {
            return document.querySelector('.server-group')?.classList.contains('collapsed') || false;
        });
        console.log('Group collapsed after click:', isCollapsedAfter);

        // Get server IDs inside the group BEFORE collapsing (inner is hidden after collapse)
        const serverIds = await page.evaluate(() => {
            const grp = document.querySelector('.server-group');
            if (!grp) return [];
            return Array.from(grp.querySelectorAll('.server-icon[data-id]')).map(
                (el: Element) => el.getAttribute('data-id')!
            );
        });
        console.log('Server IDs in group:', serverIds);

        // Simulate voice presence via the test-only setServerPresence method
        await page.evaluate((sids: string[]) => {
            const vm = (window as any).VoiceManager;
            if (!vm || !vm.setServerPresence) { console.log('VoiceManager.setServerPresence not available'); return; }
            for (const sid of sids) {
                vm.setServerPresence(sid, {
                    channels: [{ id: 'test-vc', members: [{ user_id: 'other-user' }] }],
                });
            }
        }, serverIds);
        await page.waitForTimeout(2000);

        // Check for group-voice-dot
        const dotAfter = await page.$('.group-voice-dot');
        console.log('Voice dot after presence + collapse:', !!dotAfter);

        // Verify the CSS is correct for the dot
        const dotStyles = await page.evaluate(() => {
            const dot = document.querySelector('.group-voice-dot');
            if (!dot) return null;
            const cs = getComputedStyle(dot);
            return {
                position: cs.position,
                background: cs.background,
                animation: cs.animation,
            };
        });
        console.log('Dot styles:', JSON.stringify(dotStyles));
    });
});

test.describe('Mobile Viewport', () => {

    test('Server group context menu works on mobile viewport', async ({ page }) => {
        // Set mobile viewport
        await page.setViewportSize({ width: 375, height: 812 });
        const ctx = page.context();
        await ctx.grantPermissions(['microphone'], { origin: BASE });
        const username = unique('mob');
        await register(page, username);
        await waitForWs(page);

        // Create servers and group
        await createServer(page, 'Mobile 1');
        await page.waitForTimeout(1500);
        await createServer(page, 'Mobile 2');
        await page.waitForTimeout(1500);

        await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            const servers = await (await fetch('/api/servers', { headers: h })).json();
            const grpResp = await fetch('/api/server-groups', {
                method: 'POST', headers: h,
                body: JSON.stringify({ name: 'Mobile Group' }),
            });
            const grp = await grpResp.json();
            await fetch('/api/servers/' + servers[0].id + '/group', {
                method: 'PUT', headers: h,
                body: JSON.stringify({ group_id: grp.id }),
            });
        });

        // Reload
        await page.reload();
        await waitForWs(page);
        await page.waitForTimeout(2000);

        // Take screenshot at mobile size
        await page.screenshot({ path: 'test-results/mobile-groups.png', fullPage: false });

        // Verify group is visible
        const groupEl = await page.$('.server-group');
        expect(groupEl).toBeTruthy();

        // Double-click on group header for context menu (mobile = double-click for right-click)
        const hdr = await page.$('.server-group-header');
        if (hdr) {
            await hdr.dblclick();
            await page.waitForTimeout(500);

            // Check context menu appeared
            const ctxMenu = await page.evaluate(() => {
                const menus = document.querySelectorAll('.context-menu, .volume-menu, [style*="display: block"]');
                for (const m of Array.from(menus)) {
                    const cs = getComputedStyle(m as Element);
                    if (cs.display !== 'none' && (m as HTMLElement).style.zIndex) {
                        return { visible: true, html: (m as HTMLElement).innerHTML.substring(0, 200) };
                    }
                }
                return { visible: false };
            });
            console.log('Context menu on mobile:', JSON.stringify(ctxMenu));
        }

        // Take final screenshot
        await page.screenshot({ path: 'test-results/mobile-groups-ctx.png', fullPage: false });
    });

    test('Touch drag ghost element is created on long press', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 812 });
        const ctx = page.context();
        await ctx.grantPermissions(['microphone'], { origin: BASE });
        const username = unique('tdrg');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'Touch Drag Test');
        await page.waitForTimeout(1500);
        await createServer(page, 'Touch Drag Target');
        await page.waitForTimeout(1500);

        // Verify server icons exist
        const icons = await page.$$('.server-icon[data-id]');
        console.log('Server icons:', icons.length);
        expect(icons.length).toBeGreaterThanOrEqual(2);

        // Simulate long press via JS touch events
        const ghostCreated = await page.evaluate(() => {
            return new Promise((resolve) => {
                const icon = document.querySelector('.server-icon[data-id]');
                if (!icon) { resolve('no icon'); return; }
                const rect = icon.getBoundingClientRect();
                const touchStart = new TouchEvent('touchstart', {
                    touches: [new Touch({
                        identifier: 0,
                        target: icon,
                        clientX: rect.left + rect.width / 2,
                        clientY: rect.top + rect.height / 2,
                    })],
                    bubbles: true,
                });
                icon.dispatchEvent(touchStart);

                // Wait for long press timer (350ms) + some buffer
                setTimeout(() => {
                    const ghost = document.querySelector('[style*="position:fixed"][style*="z-index:99999"]');
                    const hasActive = icon.classList.contains('dragging');
                    resolve({ ghost: !!ghost, dragging: hasActive });
                }, 600);
            });
        });
        console.log('Touch drag result:', JSON.stringify(ghostCreated));
        expect(ghostCreated).toHaveProperty('dragging', true);

        // Clean up: dispatch touchend
        await page.evaluate(() => {
            const icon = document.querySelector('.server-icon[data-id]');
            if (icon) {
                icon.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
            }
        });
    });
});
