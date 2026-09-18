import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASSWORD = 'testpass1234';

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

test('PROBE: what is encrypted at rest in localStorage', async ({ browser }) => {
    test.setTimeout(180000);
    const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await register(page, unique('probe_sec'));

    const dump = await page.evaluate(() => {
        const uid = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}').id; } catch (_) { return null; } })();
        const rows: any[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) as string;
            const raw = (window as any)._secGetRaw ? (window as any)._secGetRaw(k) : null;
            const dec = (window as any)._secGet ? (window as any)._secGet(k) : null;
            rows.push({
                key: k,
                encAtRest: typeof raw === 'string' && raw.charAt(0) === '~',
                rawLen: raw ? raw.length : 0,
                decLen: dec ? dec.length : 0,
                decHead: dec ? dec.substring(0, 24) : null,
            });
        }
        const priv = uid ? (window as any)._secGetRaw('e2e_identity_private_' + uid) : null;
        return {
            uid,
            rows: rows.filter((r) => /identity|token|user$|e2e_/.test(r.key)),
            identityPrivateRawPrefix: priv ? priv.substring(0, 20) : null,
            identityPrivateEncrypted: !!priv && priv.charAt(0) === '~',
            hasSecInit: typeof (window as any)._secInit === 'function',
        };
    });

    console.log('=== STORAGE PROBE ===');
    console.log(JSON.stringify(dump, null, 2));
    expect(dump.uid).toBeTruthy();
    await ctx.close();
});

test('PROBE: role names in the DB and API', async ({ browser }) => {
    test.setTimeout(180000);
    const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await register(page, unique('probe_role'));

    const created = await page.evaluate(async () => {
        const E = (window as any).E2ECrypto;
        const token = localStorage.getItem('token');
        const key = E.generateSymmetricKey();
        const enc = E.aeadEncrypt('Secret Lab', key);
        const res = await fetch('/api/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({
                name: 'Secret Lab',
                encrypted_name: enc.ciphertext, name_nonce: enc.nonce,
                channel_encrypted_name: enc.ciphertext, channel_name_nonce: enc.nonce,
                voice_channel_encrypted_name: enc.ciphertext, voice_channel_name_nonce: enc.nonce,
                invite_code: 'PROBE' + Math.random().toString(36).slice(2, 10).toUpperCase(),
            }),
        });
        if (!res.ok) return { error: 'server create ' + res.status };
        const sid = (await res.json()).id;
        E.saveServerKey(sid, key);

        // Create a role the way the client does: encrypted name + plaintext name.
        const encRole = E.encryptMessage('Top Secret Role', key);
        const cr = await fetch(`/api/servers/${sid}/roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({
                name: 'Top Secret Role',
                color: '#ff0000',
                permissions: 0,
                position: 10,
                encrypted_name: encRole.ciphertext,
                name_nonce: encRole.nonce,
            }),
        });
        const roleBody = await cr.json().catch(() => ({}));
        const lr = await fetch(`/api/servers/${sid}/roles`, { headers: { 'Authorization': 'Bearer ' + token } });
        const list = await lr.json().catch(() => ({}));
        const mem = await fetch(`/api/servers/${sid}/members`, { headers: { 'Authorization': 'Bearer ' + token } });
        const members = await mem.json().catch(() => ({}));
        return { sid, roleStatus: cr.status, roleBody, list, members };
    });

    console.log('=== ROLE PROBE ===');
    console.log(JSON.stringify(created, null, 2));
    await page.screenshot({ path: 'test-results/_probe/role-probe.png' });
    await ctx.close();
});
