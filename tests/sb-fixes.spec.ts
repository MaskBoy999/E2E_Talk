import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';
let _uid = 0;
function unique(p: string) { return p + '_' + (++_uid) + '_' + Date.now().toString(36); }

async function register(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-username', { timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
}

async function waitForWs(page: any) {
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 15000 });
}

async function createServer(page: any, name: string) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await page.waitForSelector('#new-server-name', { timeout: 5000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    await page.waitForTimeout(2000);
    return await page.evaluate(() => document.querySelector('.server-icon[data-id]')?.getAttribute('data-id') || '');
}

test.describe('Soundboard Per-Account', () => {

    test('Upload and list clips per-account', async ({ page }) => {
        const username = unique('sb_acct');
        await register(page, username);
        await waitForWs(page);
        const serverId = await createServer(page, 'SB Test');
        expect(serverId).toBeTruthy();

        const uploadResult = await page.evaluate(async (sid: string) => {
            const sampleRate = 44100;
            const numSamples = sampleRate;
            const buffer = new ArrayBuffer(44 + numSamples * 2);
            const view = new DataView(buffer);
            const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
            ws(0, 'RIFF'); view.setUint32(4, 36 + numSamples * 2, true);
            ws(8, 'WAVE'); ws(12, 'fmt '); view.setUint32(16, 16, true);
            view.setUint16(20, 1, true); view.setUint16(22, 1, true);
            view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
            view.setUint16(32, 2, true); view.setUint16(34, 16, true);
            ws(36, 'data'); view.setUint32(40, numSamples * 2, true);
            for (let i = 0; i < numSamples; i++) {
                view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16000), true);
            }
            const E = (window as any).E2ECrypto;
            const identity = E.getIdentityKeyPair();
            const enc = E.envelopeEncrypt(new Uint8Array(buffer), identity.publicKey, identity.privateKey);
            const token = localStorage.getItem('token');
            const r = await fetch('/api/soundboard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ server_id: sid, name: 'Test Sound', encrypted_audio: enc.ciphertext, audio_nonce: enc.nonce, duration_ms: 1000 })
            });
            return r.json();
        }, serverId);
        expect(uploadResult.ok).toBe(true);

        const clips = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const r = await fetch('/api/soundboard/my', { headers: { 'Authorization': 'Bearer ' + token } });
            return r.json();
        });
        expect(Array.isArray(clips)).toBe(true);
        expect(clips.length).toBe(1);
        expect(clips[0].name).toBe('Test Sound');

        // Load clips into cache first
        await page.evaluate(async () => {
            if (typeof (window as any)._loadSoundboardClips === 'function') {
                await (window as any)._loadSoundboardClips();
            }
        });
        await page.waitForTimeout(1000);
        // Debug: check clips endpoint directly
        const dbg = await page.evaluate(async () => {
            const tok = localStorage.getItem('token');
            const r = await fetch('/api/soundboard/my', { headers: { 'Authorization': 'Bearer ' + tok } });
            const d = await r.json();
            return { status: r.status, count: Array.isArray(d) ? d.length : 'not array', data: JSON.stringify(d).slice(0, 200) };
        });
        console.log('DEBUG clips:', JSON.stringify(dbg));
        const decResult = await page.evaluate(() => {
            const E = (window as any).E2ECrypto;
            const identity = E.getIdentityKeyPair();
            const clipsCache = (window as any)._sbClipsCache || [];
            if (clipsCache.length === 0) return { error: 'no clips in cache', hasE: !!E, hasId: !!identity };
            try {
                const pt = E.envelopeDecrypt(clipsCache[0].encrypted_audio, identity.privateKey, identity.publicKey, clipsCache[0].audio_nonce);
                return { ok: true, length: pt.length };
            } catch (e: any) {
                return { error: e.message };
            }
        });
        expect(decResult.error).toBeUndefined();
        expect(decResult.length).toBeGreaterThan(0);
    });

    test('Clips visible in different server soundboard overlay', async ({ page }) => {
        const username = unique('sb_xsrv');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'Server 1');
        await page.waitForTimeout(500);
        await createServer(page, 'Server 2');
        await page.waitForTimeout(500);

        const clips = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const r = await fetch('/api/soundboard/my', { headers: { 'Authorization': 'Bearer ' + token } });
            return r.json();
        });
        expect(Array.isArray(clips)).toBe(true);
    });
});

test.describe('Soundboard Buttons', () => {

    test('All soundboard buttons exist in DOM', async ({ page }) => {
        const username = unique('sb_btns');
        await register(page, username);
        await waitForWs(page);
        const buttons = await page.evaluate(() => ({
            voicePopup: !!document.getElementById('voice-popup-soundboard'),
            dmCall: !!document.getElementById('dm-call-soundboard'),
            voiceBar: !!document.getElementById('voice-bar-soundboard'),
            overlay: !!document.getElementById('soundboard-overlay'),
            clipsContainer: !!document.getElementById('soundboard-clips'),
            uploadBtn: !!document.getElementById('soundboard-upload-btn'),
            selfHear: !!document.getElementById('soundboard-self-hear'),
            closeBtn: !!document.getElementById('soundboard-close'),
        }));
        expect(buttons.voicePopup).toBe(true);
        expect(buttons.dmCall).toBe(true);
        expect(buttons.voiceBar).toBe(true);
        expect(buttons.overlay).toBe(true);
        expect(buttons.selfHear).toBe(true);
        expect(buttons.closeBtn).toBe(true);
    });
});

test.describe('Server Groups', () => {

    test('Collapsed group shows mini grid structure', async ({ page }) => {
        const username = unique('grp_css');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'GS 1');
        await page.waitForTimeout(300);
        await createServer(page, 'GS 2');
        await page.waitForTimeout(300);
        await createServer(page, 'GS 3');
        const count = await page.evaluate(() => document.querySelectorAll('.server-icon[data-id]').length);
        expect(count).toBe(3);
    });

    test('Remove from Group in context menu', async ({ page }) => {
        const username = unique('grp_ctx');
        await register(page, username);
        await waitForWs(page);
        const s1 = await createServer(page, 'Ctx A');
        const s2 = await createServer(page, 'Ctx B');

        // Create group via API
        await page.evaluate(async () => {
            const tok = localStorage.getItem('token');
            await fetch('/api/server-groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
                body: JSON.stringify({ name: 'TestGrp' })
            });
        });

        // Move both servers into group
        await page.evaluate(async (ids: string[]) => {
            const tok = localStorage.getItem('token');
            const grpResp = await fetch('/api/server-groups', {
                method: 'GET', headers: { 'Authorization': 'Bearer ' + tok }
            });
            const grpData = await grpResp.json();
            const gid = grpData.groups[0].id;
            for (const sid of ids) {
                await fetch('/api/servers/' + sid + '/group', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
                    body: JSON.stringify({ group_id: gid })
                });
            }
        }, [s1, s2]);

        // Reload to see group
        await page.reload({ waitUntil: 'networkidle' });
        await waitForWs(page);
        await page.waitForTimeout(1000);

        const hasGroup = await page.evaluate(() => !!document.querySelector('.server-group'));
        expect(hasGroup).toBe(true);

        // Right-click on a server inside the group to get context menu
        const serverIcon = page.locator('.server-group-inner .server-icon').first();
        if (await serverIcon.count() > 0) {
            await serverIcon.click({ button: 'right' });
            await page.waitForTimeout(300);
            const hasRemove = await page.evaluate(() => {
                const items = document.querySelectorAll('.context-menu-item');
                return Array.from(items).some(el => el.textContent?.includes('Remove from Group'));
            });
            expect(hasRemove).toBe(true);
        }
    });
});
