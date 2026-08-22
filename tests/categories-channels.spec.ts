import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

/**
 * All category + channel tests run in ONE session to avoid registration rate limits.
 * Each CHECK is labelled so failures are easy to diagnose.
 */
test.describe('Channel Categories & Channels (all-in-one)', () => {

    test('full category/channel lifecycle', async ({ page }) => {
        const ts = Date.now();
        const username = 'cat_full_' + ts;

        page.on('pageerror', err => console.log(`[PAGE_ERROR] ${err.message}`));

        // ── Register ─────────────────────────────────────────────
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'TestPass123!');
        await page.fill('#register-confirm-password', 'TestPass123!');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 30000 });
        await page.waitForTimeout(2000);
        console.log('✓ Registered');

        // ── Create server ────────────────────────────────────────
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await page.click('#choice-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
        await page.fill('#new-server-name', 'CatTest');
        await page.click('#confirm-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'hidden', timeout: 10000 });
        await page.waitForTimeout(2000);
        console.log('✓ Server created');

        // ── Select server & load channels ────────────────────────
        await page.waitForSelector('.server-icon[data-id]:not(.add-server)', { timeout: 10000 });
        await page.locator('.server-icon[data-id]:not(.add-server)').first().click();
        await page.waitForSelector('.channel-item', { timeout: 30000 });
        await page.waitForTimeout(1000);
        console.log('✓ Channels loaded');

        // ── CHECK 1: Categories visible ──────────────────────────
        const catCount = await page.locator('.channel-category-header').count();
        expect(catCount).toBe(2); // Text Channels + Voice Channels
        console.log(`✓ CHECK 1: ${catCount} categories visible`);

        // ── CHECK 2: General channel inside category ─────────────
        const channelTexts = await page.locator('.channel-item').allTextContents();
        expect(channelTexts.some(t => t.includes('general'))).toBeTruthy();
        console.log('✓ CHECK 2: general channel visible');

        // ── CHECK 3: Category headers have correct names ─────────
        const headers = await page.locator('.channel-category-header').allTextContents();
        expect(headers.some(h => h.includes('Text Channels'))).toBeTruthy();
        expect(headers.some(h => h.includes('Voice Channels'))).toBeTruthy();
        console.log('✓ CHECK 3: Category names correct');

        // ── CHECK 4: Collapse/expand ─────────────────────────────
        const firstGroup = page.locator('.channel-category-group').first();
        const header = firstGroup.locator('.channel-category-header');
        const body = firstGroup.locator('.channel-category-body');
        await header.click();
        await page.waitForTimeout(300);
        await expect(body).not.toBeVisible();
        await header.click();
        await page.waitForTimeout(300);
        await expect(body).toBeVisible();
        console.log('✓ CHECK 4: Collapse/expand works');

        // ── CHECK 5: Owner buttons present ───────────────────────
        await expect(page.locator('.create-channel-btn', { hasText: '+ Category' })).toBeVisible();
        await expect(page.locator('.create-channel-btn', { hasText: '+ Channel' })).toBeVisible();
        console.log('✓ CHECK 5: Owner buttons visible');

        // ── CHECK 6: Rename category via API ─────────────────────
        const renameCat = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
            if (!token || !sid) return null;
            const catRes = await fetch(`/api/servers/${sid}/categories`, { headers: { 'Authorization': 'Bearer ' + token } });
            const cats = await catRes.json();
            const catId = cats[0].id;
            const kb = localStorage.getItem('e2e_server_' + sid);
            const kbArr = new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(kb));
            const enc = (window as any).E2ECrypto.aeadEncrypt('My Category', kbArr);
            const res = await fetch(`/api/servers/${sid}/categories/${catId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ encrypted_name: enc.ciphertext, name_nonce: enc.nonce }),
            });
            return res.json();
        });
        expect(renameCat.ok).toBe(true);
        console.log('✓ CHECK 6: Category rename API works');

        // ── CHECK 7: Rename channel via API ──────────────────────
        const renameCh = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
            if (!token || !sid) return null;
            const chRes = await fetch(`/api/servers/${sid}/channels`, { headers: { 'Authorization': 'Bearer ' + token } });
            const channels = await chRes.json();
            const chId = channels[0].id;
            const kb = localStorage.getItem('e2e_server_' + sid);
            const kbArr = new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(kb));
            const enc = (window as any).E2ECrypto.aeadEncrypt('my-channel', kbArr);
            const res = await fetch(`/api/servers/${sid}/channels/${chId}/name`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ encrypted_name: enc.ciphertext, name_nonce: enc.nonce }),
            });
            return res.json();
        });
        expect(renameCh.ok).toBe(true);
        console.log('✓ CHECK 7: Channel rename API works');

        // ── CHECK 8: Renames persist after reload ────────────────
        await page.reload();
        await page.waitForSelector('.server-icon[data-id]:not(.add-server)', { timeout: 15000 });
        await page.locator('.server-icon[data-id]:not(.add-server)').first().click();
        await page.waitForSelector('.channel-item', { timeout: 30000 });
        await page.waitForTimeout(1000);

        const headersAfter = await page.locator('.channel-category-header').allTextContents();
        expect(headersAfter.some(h => h.includes('My Category'))).toBeTruthy();
        const channelsAfter = await page.locator('.channel-item').allTextContents();
        expect(channelsAfter.some(c => c.includes('my-channel'))).toBeTruthy();
        console.log('✓ CHECK 8: Renames persist after reload');

        // ── CHECK 9: Create second category & move channel ───────
        const cat2 = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
            if (!token || !sid) return null;
            const kb = localStorage.getItem('e2e_server_' + sid);
            const kbArr = new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(kb));
            const enc = (window as any).E2ECrypto.aeadEncrypt('Second Cat', kbArr);
            const res = await fetch(`/api/servers/${sid}/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ encrypted_name: enc.ciphertext, name_nonce: enc.nonce, position: 2 }),
            });
            return res.json();
        });
        expect(cat2.id).toBeTruthy();

        const moved = await page.evaluate(async (catId: string) => {
            const token = localStorage.getItem('token');
            const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
            const ch = document.querySelector('.channel-item[data-id]');
            if (!token || !sid || !ch) return null;
            const res = await fetch(`/api/servers/${sid}/channels/${ch.getAttribute('data-id')}/category`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ category_id: catId }),
            });
            return res.json();
        }, cat2.id);
        expect(moved.ok).toBe(true);

        await page.reload();
        await page.waitForSelector('.server-icon[data-id]:not(.add-server)', { timeout: 15000 });
        await page.locator('.server-icon[data-id]:not(.add-server)').first().click();
        await page.waitForSelector('.channel-item', { timeout: 30000 });
        await page.waitForTimeout(1000);
        expect(await page.locator('.channel-category-header').count()).toBe(3);
        console.log('✓ CHECK 9: Second category created, channel moved');

        // ── CHECK 10: Move channel to uncategorized ──────────────
        const uncat = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
            const ch = document.querySelector('.channel-item[data-id]');
            if (!token || !sid || !ch) return null;
            const res = await fetch(`/api/servers/${sid}/channels/${ch.getAttribute('data-id')}/category`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ category_id: null }),
            });
            return res.json();
        });
        expect(uncat.ok).toBe(true);

        await page.reload();
        await page.waitForSelector('.server-icon[data-id]:not(.add-server)', { timeout: 15000 });
        await page.locator('.server-icon[data-id]:not(.add-server)').first().click();
        await page.waitForSelector('.channel-item', { timeout: 30000 });
        await page.waitForTimeout(1000);
        const allHeaders = await page.locator('.channel-category-header').allTextContents();
        expect(allHeaders.some(h => h.includes('Uncategorized'))).toBeTruthy();
        console.log('✓ CHECK 10: Channel moved to uncategorized');

        // ── CHECK 11: Delete category removes its channels ───────
        // Create another category with a temp channel
        const setup = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
            if (!token || !sid) return null;
            const kb = localStorage.getItem('e2e_server_' + sid);
            const kbArr = new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(kb));
            const catEnc = (window as any).E2ECrypto.aeadEncrypt('Deleteme', kbArr);
            const catRes = await fetch(`/api/servers/${sid}/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ encrypted_name: catEnc.ciphertext, name_nonce: catEnc.nonce, position: 5 }),
            });
            const catData = await catRes.json();
            const chEnc = (window as any).E2ECrypto.aeadEncrypt('temp-ch', kbArr);
            const chRes = await fetch(`/api/servers/${sid}/channels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ encrypted_name: chEnc.ciphertext, name_nonce: chEnc.nonce, channel_type: 'text' }),
            });
            const chData = await chRes.json();
            await fetch(`/api/servers/${sid}/channels/${chData.id}/category`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ category_id: catData.id }),
            });
            return { catId: catData.id };
        });

        const del = await page.evaluate(async (catId: string) => {
            const token = localStorage.getItem('token');
            const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
            const res = await fetch(`/api/servers/${sid}/categories/${catId}`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + token },
            });
            return res.json();
        }, setup!.catId);
        expect(del.ok).toBe(true);

        await page.reload();
        await page.waitForSelector('.server-icon[data-id]:not(.add-server)', { timeout: 15000 });
        await page.locator('.server-icon[data-id]:not(.add-server)').first().click();
        await page.waitForSelector('.channel-item', { timeout: 30000 });
        await page.waitForTimeout(1000);
        const allChAfter = await page.locator('.channel-item').allTextContents();
        expect(allChAfter.some(c => c.includes('temp-ch'))).toBe(false);
        console.log('✓ CHECK 11: Deleted category & channel gone');

        // ── CHECK 12: Cannot delete the last category ────────────
        const lastCats = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
            const res = await fetch(`/api/servers/${sid}/categories`, { headers: { 'Authorization': 'Bearer ' + token } });
            return res.json();
        });
        // Delete all but one
        for (let i = lastCats.length - 1; i > 0; i--) {
            await page.evaluate(async (catId: string) => {
                const token = localStorage.getItem('token');
                const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
                await fetch(`/api/servers/${sid}/categories/${catId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token },
                });
            }, lastCats[i].id);
        }
        const lastDel = await page.evaluate(async (catId: string) => {
            const token = localStorage.getItem('token');
            const sid = document.querySelector('.server-icon[data-id]')?.getAttribute('data-id');
            const res = await fetch(`/api/servers/${sid}/categories/${catId}`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + token },
            });
            return { status: res.status, body: await res.json() };
        }, lastCats[0].id);
        expect(lastDel.status).toBe(400);
        expect(lastDel.body.error).toContain('Cannot delete the last category');
        console.log('✓ CHECK 12: Cannot delete last category');

        // ── CHECK 13: Every server has at least one category ──────
        expect(await page.locator('.channel-category-group').count()).toBeGreaterThanOrEqual(1);
        console.log('✓ CHECK 13: At least one category always exists');

        console.log('\n🎉 ALL 13 CHECKS PASSED\n');
    });
});
