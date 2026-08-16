import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

const BASE = 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function createServerAndKey(page: any, token: string, userId: string) {
    const inviteCode = generateCode(8);
    const encName = await page.evaluate(() => {
        const key = E2ECrypto.generateSymmetricKey();
        return {
            keyB64: E2ECrypto.arrayBufferToBase64(key),
            encName: E2ECrypto.encryptMessage('Reaction Test Server', key),
            encChName: E2ECrypto.encryptMessage('general', key),
        };
    });
    const res = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: encName.encName.ciphertext,
            name_nonce: encName.encName.nonce,
            channel_encrypted_name: encName.encChName.ciphertext,
            channel_name_nonce: encName.encChName.nonce,
        },
    });
    const server = await res.json();
    await page.evaluate(async ({ serverId, userId, keyB64 }: { serverId: string; userId: string; keyB64: string }) => {
        const serverKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId, keyB64: encName.keyB64 });
    const channels = await (await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
    })).json();
    return { serverId: server.id, channelId: channels[0].id, inviteCode };
}

async function joinServerAndLoadKey(ownerPage: any, userPage: any, ownerToken: string, serverId: string, inviteCode: string, otherUserId: string) {
    const joinRes = await userPage.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${userPage.token}` },
        data: { code: inviteCode },
    });
    expect(joinRes.ok()).toBe(true);
    const otherPub = await userPage.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
    await ownerPage.evaluate(async ({ serverId, otherUserId, otherPub }: { serverId: string; otherUserId: string; otherPub: string }) => {
        const serverKey = E2ECrypto.getServerKey(serverId);
        const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherPub));
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: otherUserId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId, otherUserId, otherPub });
    const ok = await userPage.evaluate(async ({ serverId }: { serverId: string }) => {
        return typeof fetchAndDecryptServerKey === 'function' ? await fetchAndDecryptServerKey(serverId) : false;
    }, { serverId });
    expect(ok).toBe(true);
}

async function waitForWs(page: any) {
    return await page.evaluate(() => new Promise((resolve) => {
        let tries = 0;
        const check = () => {
            tries++;
            if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
            else if (tries >= 60) resolve(false);
            else setTimeout(check, 100);
        };
        check();
    }));
}

async function sendServerMessageViaWs(page: any, channelId: string, serverId: string, text: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, text }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const enc = E2ECrypto.encryptMessage(JSON.stringify({ type: 'text', text }), key);
        ws.send(JSON.stringify({
            type: 'message_send',
            channel_id: channelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        }));
        return 'sent';
    }, { channelId, serverId, text });
}

// React to a channel message via the real WS path (E2E payload + blind token).
async function sendChannelReaction(page: any, channelId: string, serverId: string, messageId: string, canonical: string, payloadExtra: any) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, messageId, canonical, payloadExtra }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const payload = Object.assign({ e: canonical }, payloadExtra || {});
        const enc = E2ECrypto.encryptMessage(JSON.stringify(payload), key);
        const token = E2ECrypto.hmacHex(key, 'reaction-v1:' + canonical);
        ws.send(JSON.stringify({
            type: 'message_reaction',
            channel_id: channelId,
            message_id: messageId,
            emoji_token: token,
            encrypted_emoji: enc.ciphertext,
            emoji_nonce: enc.nonce,
        }));
        return 'sent';
    }, { channelId, serverId, messageId, canonical, payloadExtra });
}

// React to a DM message via the real WS path.
async function sendDmReaction(page: any, dmChannelId: string, otherUserId: string, messageId: string, canonical: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ dmChannelId, otherUserId, messageId, canonical }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        if (!kp) return 'no_identity';
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const data = await res.json();
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const dk = E2ECrypto.getDmKey(dmChannelId, kp.privateKey, otherPub);
        const payload = { e: canonical };
        const enc = E2ECrypto.encryptMessage(JSON.stringify(payload), dk);
        const token = E2ECrypto.hmacHex(dk, 'reaction-v1:' + canonical);
        ws.send(JSON.stringify({
            type: 'dm_reaction',
            dm_channel_id: dmChannelId,
            message_id: messageId,
            emoji_token: token,
            encrypted_emoji: enc.ciphertext,
            emoji_nonce: enc.nonce,
        }));
        return 'sent';
    }, { dmChannelId, otherUserId, messageId, canonical });
}

// Build a tiny real PNG so the profile-picture upload passes the server's
// image validation.
function makeMinimalPng(width = 50, height = 50, r = 255, g = 0, b = 0): Buffer {
    const zlib = require('zlib');
    const raw = Buffer.alloc(1 + width * height * 3, 0);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;
        for (let x = 0; x < width; x++) {
            const idx = y * (width * 3 + 1) + 1 + x * 3;
            raw[idx] = r; raw[idx + 1] = g; raw[idx + 2] = b;
        }
    }
    const deflated = zlib.deflateSync(raw);
    function crc32(buf: Buffer): number {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            crc ^= buf[i];
            for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function u32(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; }
    const parts: Buffer[] = [];
    parts.push(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const ihdrType = Buffer.from('IHDR');
    parts.push(u32(13), ihdrType, ihdr, u32(crc32(Buffer.concat([ihdrType, ihdr]))));
    const idatType = Buffer.from('IDAT');
    parts.push(u32(deflated.length), idatType, deflated, u32(crc32(Buffer.concat([idatType, deflated]))));
    const iendType = Buffer.from('IEND');
    parts.push(u32(0), iendType, u32(crc32(iendType)));
    return Buffer.concat(parts);
}

// Upload a real profile picture through the app's saveProfile() flow so the
// DM conversation profile (encrypted with the DM key) carries the PFP file id
// + key — exactly what the on-demand DM hover fetch needs to render the avatar.
async function uploadProfilePicture(page: any, token: string, pngBytes: Buffer): Promise<string> {
    const initRes = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: pngBytes.length, mime: 'image/png' },
    });
    expect(initRes.ok()).toBeTruthy();
    const { file_id } = await initRes.json();

    const fileKeyB64: string = await page.evaluate(async ({ fileId, pngBase64 }) => {
        const rawBytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
        const fileKey = E2ECrypto.generateFileKey();
        const encrypted = E2ECrypto.encryptFileChunk(fileKey, rawBytes);
        const blob = new Blob([encrypted], { type: 'application/octet-stream' });
        await fetch(`/api/files/${fileId}/chunk/0`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: blob,
        });
        await fetch(`/api/files/${fileId}/complete`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        return E2ECrypto.arrayBufferToBase64(fileKey);
    }, { fileId: file_id, pngBase64: pngBytes.toString('base64') });

    const status = await page.evaluate(async ({ fid, fk }) => {
        (profilePfpFileId as any) = fid;
        (profilePfpFileKey as any) = fk;
        (_removePfpFlag as any) = false;
        const statusEl = document.getElementById('profile-edit-status');
        try {
            await (saveProfile as any)();
            return statusEl ? (statusEl.textContent || '') : 'no-status-el';
        } catch (e) { return 'ERR ' + e; }
    }, { fid: file_id, fk: fileKeyB64 });
    expect(status).toContain('Profile saved');
    await page.waitForTimeout(800);
    return file_id;
}

// Fetch a channel message + its reactions via REST.
async function getChannelMessage(page: any, channelId: string, serverId: string, messageId: string) {
    return await page.evaluate(async ({ channelId, serverId, messageId }) => {
        const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const msgs = await res.json();
        const key = E2ECrypto.getServerKey(serverId);
        for (const m of msgs || []) {
            if (m.id === messageId) {
                let decrypted = '';
                try { decrypted = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key); } catch (_) {}
                return { msg: m, decrypted };
            }
        }
        return null;
    }, { channelId, serverId, messageId });
}

test.describe('E2E-encrypted message reactions', () => {

    test('channel reaction: add shows a pill with count + mine highlight; toggling removes it', async ({ page }) => {
        const u = 'rct_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);

        expect(await sendServerMessageViaWs(page, channelId, serverId, 'hello reactions')).toBe('sent');
        await page.waitForTimeout(400);
        const textMap = await page.evaluate(async ({ channelId, serverId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const key = E2ECrypto.getServerKey(serverId);
            const map: Record<string, string> = {};
            for (const m of msgs || []) {
                try { map[m.id] = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key); } catch (_) {}
            }
            return map;
        }, { channelId, serverId });
        const messageId = Object.keys(textMap)[0];
        expect(messageId).toBeTruthy();

        // React 👍
        expect(await sendChannelReaction(page, channelId, serverId, messageId, '👍', null)).toBe('sent');
        await page.waitForTimeout(500);

        let got = await getChannelMessage(page, channelId, serverId, messageId);
        expect(got).not.toBeNull();
        expect((got.msg.reactions || []).length).toBe(1);
        expect(got.msg.reactions[0].reactor_user_id).toBe(body.user.id);
        expect(got.msg.reactions[0].emoji_token.length).toBe(64);

        // Toggle off — same canonical → server removes the reaction.
        expect(await sendChannelReaction(page, channelId, serverId, messageId, '👍', null)).toBe('sent');
        await page.waitForTimeout(500);
        got = await getChannelMessage(page, channelId, serverId, messageId);
        expect((got.msg.reactions || []).length).toBe(0);
    });

    test('custom emoji reaction renders with file metadata; DB stays blind', async ({ page }) => {
        const u = 'rctc_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);
        expect(await sendServerMessageViaWs(page, channelId, serverId, 'react to me')).toBe('sent');
        await page.waitForTimeout(400);

        const textMap = await page.evaluate(async ({ channelId, serverId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const key = E2ECrypto.getServerKey(serverId);
            const map: Record<string, string> = {};
            for (const m of msgs || []) {
                try { map[m.id] = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key); } catch (_) {}
            }
            return map;
        }, { channelId, serverId });
        const messageId = Object.keys(textMap)[0];

        // Custom emoji: payload carries file_id/file_key so recipients can render.
        const fakeFileId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const fakeFileKey = await page.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.generateSymmetricKey()));
        expect(await sendChannelReaction(page, channelId, serverId, messageId, ':pepe:', {
            f: fakeFileId, k: fakeFileKey, m: 'image/png',
        })).toBe('sent');
        await page.waitForTimeout(500);

        const got = await getChannelMessage(page, channelId, serverId, messageId);
        expect((got.msg.reactions || []).length).toBe(1);

        // Host-safety: stored emoji is ciphertext (never the plaintext shortcode)
        // and the token is a 64-hex HMAC.
        const dbOut = execSync(
            `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT encrypted_emoji, emoji_nonce, emoji_token FROM message_reactions').fetchall(); toks=[r[2] for r in rows]; bad=[t for t in toks if len(t)!=64 or not all(c in '0123456789abcdef' for c in t)]; encs=[r[0] for r in rows]; leaked=[e for e in encs if ':pepe:' in e or 'pepe' in e]; print(len(toks), len(bad), len(leaked), any(':pepe:' in open('server/e2e_chat.db','rb').read()) if False else 0)"`,
            { encoding: 'utf-8' }
        ).trim();
        const [n, nBad, nLeaked] = dbOut.split(' ');
        expect(parseInt(n, 10)).toBeGreaterThan(0);
        expect(parseInt(nBad, 10)).toBe(0);
        expect(parseInt(nLeaked, 10)).toBe(0);
    });

    test('reaction picker shows custom emojis at the top and ALL unicode emojis', async ({ page }) => {
        const u = 'rctp_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);

        // Upload a custom emoji so the picker's custom section has content.
        const emojiBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // tiny fake png header
        const initRes = await page.request.post(`${BASE}/api/files/init`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { size: emojiBytes.length },
        });
        expect(initRes.ok()).toBeTruthy();
        const { file_id } = await initRes.json();
        const enc = await page.evaluate(async ({ fileId }) => {
            const key = E2ECrypto.generateFileKey();
            const encChunk = E2ECrypto.encryptFileChunk(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
            await fetch(`/api/files/${fileId}/chunk/0`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: new Blob([encChunk], { type: 'application/octet-stream' }),
            });
            await fetch(`/api/files/${fileId}/complete`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const identity = E2ECrypto.getIdentityKeyPair();
            const keyB64 = E2ECrypto.arrayBufferToBase64(key);
            const encFileKey = E2ECrypto.encodeEncryptedFileKey(keyB64, identity.privateKey);
            const parts = encFileKey.split(':');
            const encMime = E2ECrypto.aeadEncrypt('image/emoji', key, null);
            return {
                encrypted_file_key: E2ECrypto.arrayBufferToBase64(E2ECrypto.base64ToArrayBuffer(parts[1])),
                file_key_nonce: parts[0],
                encrypted_mime_type: encMime.ciphertext,
                mime_nonce: encMime.nonce,
            };
        }, { fileId: file_id });
        const stRes = await page.request.post(`${BASE}/api/users/me/stickers`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { file_id, ...enc },
        });
        expect(stRes.ok()).toBeTruthy();

        // Load the app into the channel view so the message renders.
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await expect(page.locator('#message-input')).toBeEnabled({ timeout: 5000 });
        await waitForWs(page);

        // Send a message and open the picker from its react button.
        expect(await sendServerMessageViaWs(page, channelId, serverId, 'open the picker')).toBe('sent');
        await page.waitForTimeout(1000);
        const messageId = await page.evaluate(() => {
            const el = document.querySelector('.message');
            return el ? el.getAttribute('data-message-id') : null;
        });
        expect(messageId).toBeTruthy();
        await page.hover(`.message[data-message-id="${messageId}"]`);
        await page.click(`.message[data-message-id="${messageId}"] .msg-action-btn[data-action="react"]`);
        await page.waitForSelector('.reaction-picker-full', { timeout: 5000 });

        const pickerState = await page.evaluate(() => {
            const sections = Array.from(document.querySelectorAll('.reaction-picker-full .reaction-picker-section')).map((el) => el.textContent || '');
            const picks = document.querySelectorAll('.reaction-picker-full .reaction-pick');
            const custom = document.querySelectorAll('.reaction-picker-full .reaction-pick-custom');
            return {
                sectionCount: sections.length,
                firstSection: sections[0] || null,
                totalPicks: picks.length,
                customCount: custom.length,
                hasThumbsUp: Array.from(picks).some((p) => p.getAttribute('data-emoji') === '👍'),
            };
        });
        console.log('Reaction picker state:', JSON.stringify(pickerState));
        expect(pickerState.firstSection).toBe('Custom');
        expect(pickerState.customCount).toBe(1);
        expect(pickerState.totalPicks).toBeGreaterThan(200); // far beyond the old 12
        expect(pickerState.hasThumbsUp).toBe(true);
        expect(pickerState.sectionCount).toBeGreaterThanOrEqual(8); // all categories present

        // Capture the custom shortcode from the unfiltered picker before searching.
        const customEmojiName = await page.evaluate(() => {
            const c = document.querySelector('.reaction-picker-full .reaction-pick-custom');
            return c ? (c.getAttribute('data-emoji') || '').replace(/^:|:$/g, '') : null;
        });
        expect(customEmojiName).toBeTruthy();

        // Search box: typing filters custom emojis by shortcode and unicode by name.
        await page.fill('.reaction-picker-full .reaction-picker-search', 'thumbs');
        await page.waitForTimeout(150);
        const searchState = await page.evaluate(() => {
            const sections = Array.from(document.querySelectorAll('.reaction-picker-full .reaction-picker-section')).map((el) => el.textContent || '');
            const picks = Array.from(document.querySelectorAll('.reaction-picker-full .reaction-pick')).map((p) => p.getAttribute('data-emoji'));
            return { sections, picks };
        });
        console.log('Reaction search state:', JSON.stringify(searchState));
        // The full 900+ emoji grid must be filtered down to a small set.
        expect(searchState.picks.length).toBeGreaterThan(0);
        expect(searchState.picks.length).toBeLessThan(pickerState.totalPicks);
        expect(searchState.picks).toContain('👍'); // matches by name "thumbs up"

        // Searching the custom shortcode narrows to the custom emoji only.
        await page.fill('.reaction-picker-full .reaction-picker-search', customEmojiName.slice(0, 3));
        await page.waitForTimeout(150);
        const customSearch = await page.evaluate(() => Array.from(document.querySelectorAll('.reaction-picker-full .reaction-pick-custom')).map((p) => p.getAttribute('data-emoji')));
        expect(customSearch.length).toBe(1);
        expect(customSearch[0]).toBe(':' + customEmojiName + ':');

        // No matches shows the empty state and no buttons.
        await page.fill('.reaction-picker-full .reaction-picker-search', 'zzzznotanemoji');
        await page.waitForTimeout(150);
        const emptyState = await page.evaluate(() => {
            const sections = Array.from(document.querySelectorAll('.reaction-picker-full .reaction-picker-section')).map((el) => el.textContent || '');
            return { sectionText: sections.join('|'), pickCount: document.querySelectorAll('.reaction-picker-full .reaction-pick').length };
        });
        expect(emptyState.pickCount).toBe(0);
        expect(emptyState.sectionText).toContain('No emojis found');

        // Close via Escape.
        await page.keyboard.press('Escape');
        await page.waitForSelector('.reaction-picker-full', { state: 'detached', timeout: 5000 });
    });

    test('live WS: another member reacting updates the pill in place on the viewer', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'rctl_' + Date.now();
        const uB = 'rctl2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);

        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await pageA.click('.server-icon:not(.add-server)');
        await pageA.waitForSelector('.channel-item', { timeout: 10000 });
        await pageA.click('.channel-item >> nth=0');
        await expect(pageA.locator('#message-input')).toBeEnabled({ timeout: 5000 });
        await waitForWs(pageA);

        expect(await sendServerMessageViaWs(pageA, channelId, serverId, 'live reaction target')).toBe('sent');
        await pageA.waitForTimeout(600);
        const textMap = await pageA.evaluate(async ({ channelId, serverId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const key = E2ECrypto.getServerKey(serverId);
            const map: Record<string, string> = {};
            for (const m of msgs || []) {
                try { map[m.id] = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key); } catch (_) {}
            }
            return map;
        }, { channelId, serverId });
        const messageId = Object.keys(textMap)[0];

        // B reacts → A's already-rendered message gains a pill without reload.
        expect(await sendChannelReaction(pageB, channelId, serverId, messageId, '🔥', null)).toBe('sent');
        await pageA.waitForSelector(`.message[data-message-id="${messageId}"] .reaction-pill`, { timeout: 8000 });
        const pillCount = await pageA.evaluate((id) => {
            const msgEl = document.querySelector(`.message[data-message-id="${id}"]`);
            if (!msgEl) return -1;
            const pill = msgEl.querySelector('.reaction-pill');
            return pill ? parseInt(pill.getAttribute('data-count') || '0', 10) : -1;
        }, messageId);
        expect(pillCount).toBe(1);
        // Not mine (B reacted, A is viewing).
        const isMine = await pageA.evaluate((id) => {
            const pill = document.querySelector(`.message[data-message-id="${id}"] .reaction-pill`);
            return pill ? pill.classList.contains('mine') : false;
        }, messageId);
        expect(isMine).toBe(false);

        // Placement: the live-updated pill row must be INSIDE .content (under
        // the text), never a flex sibling beside it — appending to the .message
        // flex container previously pushed it to the RIGHT of the message.
        const placement = await pageA.evaluate((id) => {
            const msgEl = document.querySelector(`.message[data-message-id="${id}"]`);
            if (!msgEl) return { found: false };
            const row = msgEl.querySelector('.message-reactions');
            const contentEl = msgEl.querySelector('.content');
            if (!row || !contentEl) return { found: true, insideContent: false };
            const textEl = msgEl.querySelector('.text');
            const rowRect = row.getBoundingClientRect();
            const textRect = textEl ? textEl.getBoundingClientRect() : null;
            return {
                found: true,
                insideContent: contentEl.contains(row),
                rowTop: Math.round(rowRect.top),
                textBottom: textRect ? Math.round(textRect.bottom) : null,
                rowLeft: Math.round(rowRect.left),
            };
        }, messageId);
        console.log('Reaction placement:', JSON.stringify(placement));
        expect(placement.insideContent).toBe(true);
        if (placement.textBottom !== null) {
            expect(placement.rowTop).toBeGreaterThanOrEqual(placement.textBottom - 2);
        }

        await ctxA.close();
        await ctxB.close();
    });

    test('clicking a message emoji asks before downloading; Cancel aborts, Download saves', async ({ page }) => {
        const u = 'rcde_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);

        // Upload a tiny custom emoji so a message can render a real <img class="emoji-inline">.
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // png magic only — the client doesn't sniff
        const initRes = await page.request.post(`${BASE}/api/files/init`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { size: pngBytes.length, mime: 'image/png' },
        });
        expect(initRes.ok()).toBeTruthy();
        const { file_id } = await initRes.json();
        const emojiUpload = await page.evaluate(async ({ fileId }) => {
            const key = E2ECrypto.generateFileKey();
            const encChunk = E2ECrypto.encryptFileChunk(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
            await fetch(`/api/files/${fileId}/chunk/0`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: new Blob([encChunk], { type: 'application/octet-stream' }),
            });
            await fetch(`/api/files/${fileId}/complete`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const identity = E2ECrypto.getIdentityKeyPair();
            const keyB64 = E2ECrypto.arrayBufferToBase64(key);
            const encFileKey = E2ECrypto.encodeEncryptedFileKey(keyB64, identity.privateKey);
            const parts = encFileKey.split(':');
            const encMime = E2ECrypto.aeadEncrypt('image/emoji', key, null);
            await fetch('/api/users/me/stickers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({
                    file_id: fileId,
                    encrypted_file_key: E2ECrypto.arrayBufferToBase64(E2ECrypto.base64ToArrayBuffer(parts[1])),
                    file_key_nonce: parts[0],
                    encrypted_mime_type: encMime.ciphertext,
                    mime_nonce: encMime.nonce,
                }),
            });
            return { fileId, fileKey: keyB64 };
        }, { fileId: file_id });

        // Open the channel view and send a message containing :pepe: with the
        // shareable file refs so it renders as a real emoji image.
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await expect(page.locator('#message-input')).toBeEnabled({ timeout: 5000 });
        await waitForWs(page);

        await page.evaluate(async ({ channelId, serverId, emojiUpload }) => {
            const key = E2ECrypto.getServerKey(serverId);
            const payload = {
                type: 'text',
                text: ':pepe:',
                emojis: [{ name: 'pepe', file_id: emojiUpload.fileId, file_key: emojiUpload.fileKey, mime_type: 'image/png' }],
            };
            const enc = E2ECrypto.encryptMessage(JSON.stringify(payload), key);
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: enc.ciphertext,
                nonce: enc.nonce,
                message_nonce: enc.messageNonce || null,
            }));
        }, { channelId, serverId, emojiUpload });
        await page.waitForSelector('.message .emoji-inline', { timeout: 8000 });
        const messageId = await page.evaluate(() => {
            const el = document.querySelector('.message');
            return el ? el.getAttribute('data-message-id') : null;
        });
        expect(messageId).toBeTruthy();

        // Click → the confirm modal appears (no instant download), name shown.
        const noInstantDl = page.waitForEvent('download', { timeout: 2500 }).catch(() => null);
        await page.click('.message .emoji-inline');
        await page.waitForSelector('#emoji-download-modal', { state: 'visible', timeout: 5000 });
        const shownName = await page.evaluate(() => document.getElementById('emoji-download-name')?.textContent || '');
        expect(shownName).toBe(':pepe:');
        expect(await noInstantDl).toBeNull();

        // Cancel → modal closes, still no download.
        const afterCancelDl = page.waitForEvent('download', { timeout: 2500 }).catch(() => null);
        await page.click('#cancel-emoji-download');
        await page.waitForSelector('#emoji-download-modal', { state: 'hidden', timeout: 5000 });
        expect(await afterCancelDl).toBeNull();

        // Click again and Confirm → the emoji actually downloads.
        await page.click('.message .emoji-inline');
        await page.waitForSelector('#emoji-download-modal', { state: 'visible', timeout: 5000 });
        const dl = page.waitForEvent('download');
        await page.click('#confirm-emoji-download');
        const download = await dl;
        expect(download.suggestedFilename()).toContain('pepe');
        await page.waitForSelector('#emoji-download-modal', { state: 'hidden', timeout: 5000 });

        // Right-click a custom emoji inside a REACTION pill → context menu with
        // a direct download item (no confirm modal — right-click is deliberate).
        expect(await sendChannelReaction(page, channelId, serverId, messageId!, ':pepe:', {
            f: emojiUpload.fileId,
            k: emojiUpload.fileKey,
            m: 'image/png',
        })).toBe('sent');
        await page.waitForSelector('.message .reaction-pill img.emoji-inline', { timeout: 8000 });
        const reactionDl = page.waitForEvent('download');
        await page.click('.message .reaction-pill img.emoji-inline', { button: 'right' });
        await page.waitForSelector('.channel-context-menu', { state: 'visible', timeout: 5000 });
        const menuText = await page.evaluate(() => document.querySelector('.channel-context-menu .context-menu-item')?.textContent || '');
        expect(menuText).toContain(':pepe:');
        await page.click('.channel-context-menu .context-menu-item');
        const reactionDownload = await reactionDl;
        expect(reactionDownload.suggestedFilename()).toContain('pepe');
        await page.waitForSelector('.channel-context-menu', { state: 'detached', timeout: 5000 });

        // Right-click a STICKER → the same context menu downloads it.
        await page.evaluate(async ({ channelId, serverId, emojiUpload }) => {
            const key = E2ECrypto.getServerKey(serverId);
            const payload = {
                type: 'sticker',
                sticker_name: 'pepestick',
                file_id: emojiUpload.fileId,
                file_key: emojiUpload.fileKey,
                mime_type: 'image/png',
            };
            const enc = E2ECrypto.encryptMessage(JSON.stringify(payload), key);
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: enc.ciphertext,
                nonce: enc.nonce,
                message_nonce: enc.messageNonce || null,
            }));
        }, { channelId, serverId, emojiUpload });
        await page.waitForSelector('.message .sticker-message img', { timeout: 8000 });
        const stickerDl = page.waitForEvent('download');
        await page.click('.message .sticker-message img', { button: 'right' });
        await page.waitForSelector('.channel-context-menu', { state: 'visible', timeout: 5000 });
        const stickerMenuText = await page.evaluate(() => document.querySelector('.channel-context-menu .context-menu-item')?.textContent || '');
        expect(stickerMenuText).toContain('pepestick');
        await page.click('.channel-context-menu .context-menu-item');
        const stickerDownload = await stickerDl;
        expect(stickerDownload.suggestedFilename()).toContain('pepestick');
        await page.waitForSelector('.channel-context-menu', { state: 'detached', timeout: 5000 });

        // The hover ⬇ button on the sticker is untouched — still visible on hover.
        await page.hover('.message .sticker-message');
        await page.waitForSelector('.message .sticker-message .media-download-btn', { state: 'visible', timeout: 5000 });
        expect(await page.evaluate(() => {
            const btn = document.querySelector('.message .sticker-message .media-download-btn');
            return btn ? getComputedStyle(btn).display : '';
        })).toBe('block');
    });

    test('hovering a reaction pill shows the member card with who reacted', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'rcth_' + Date.now();
        const uB = 'rcth2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);

        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await pageA.click('.server-icon:not(.add-server)');
        await pageA.waitForSelector('.channel-item', { timeout: 10000 });
        await pageA.click('.channel-item >> nth=0');
        await expect(pageA.locator('#message-input')).toBeEnabled({ timeout: 5000 });
        await waitForWs(pageA);

        expect(await sendServerMessageViaWs(pageA, channelId, serverId, 'who reacted to this')).toBe('sent');
        await pageA.waitForTimeout(600);
        const textMap = await pageA.evaluate(async ({ channelId, serverId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const key = E2ECrypto.getServerKey(serverId);
            const map: Record<string, string> = {};
            for (const m of msgs || []) {
                try { map[m.id] = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key); } catch (_) {}
            }
            return map;
        }, { channelId, serverId });
        const messageId = Object.keys(textMap)[0];
        expect(messageId).toBeTruthy();

        // Both A and B react with the same emoji → count 2, both ids on the pill.
        expect(await sendChannelReaction(pageA, channelId, serverId, messageId, '👍', null)).toBe('sent');
        expect(await sendChannelReaction(pageB, channelId, serverId, messageId, '👍', null)).toBe('sent');
        await pageA.waitForTimeout(800);

        const pillState = await pageA.evaluate((id) => {
            const pill = document.querySelector(`.message[data-message-id="${id}"] .reaction-pill`);
            if (!pill) return null;
            return {
                count: pill.getAttribute('data-count'),
                reactors: (pill.getAttribute('data-reactors') || '').split(',').filter(Boolean),
            };
        }, messageId);
        expect(pillState).not.toBeNull();
        expect(pillState.count).toBe('2');
        expect(pillState.reactors.slice().sort()).toEqual([bodyA.user.id, bodyB.user.id].sort());

        // Hover the pill → the member card appears listing BOTH usernames.
        await pageA.hover(`.message[data-message-id="${messageId}"] .reaction-pill`);
        await pageA.waitForSelector('#msg-status-tooltip', { state: 'visible', timeout: 5000 });
        const cardText = await pageA.evaluate(() => {
            const tip = document.getElementById('msg-status-tooltip');
            return tip ? tip.textContent || '' : '';
        });
        expect(cardText).toContain('Reacted by 2 members');
        expect(cardText).toContain(uA);
        expect(cardText).toContain(uB);

        // Moving off the pill dismisses the card.
        await pageA.hover('#message-input');
        await pageA.waitForTimeout(200);
        const hidden = await pageA.evaluate(() => {
            const tip = document.getElementById('msg-status-tooltip');
            return tip ? tip.style.display === 'none' : true;
        });
        expect(hidden).toBe(true);

        await ctxA.close();
        await ctxB.close();
    });

    test('DM hover card fetches the partner profile on demand and shows the real avatar', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'rctpa_' + Date.now();
        const uB = 'rctpb_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);

        // Friend A+B and create the DM channel.
        const codeB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await pageA.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: codeB },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await pageB.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
        })).json();
        await pageB.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        const dm = await (await pageA.request.post(`${BASE}/api/dm/${bodyB.user.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const dmChannelId = dm.dm_channel_id || dm.id;

        // Reload A so the app knows about the DM, then set a REAL profile
        // picture — saveProfile uploads the DM conversation profile too.
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
        await pageA.waitForFunction(() => typeof saveProfile === 'function' && typeof profilePfpFileId !== 'undefined', { timeout: 10000 });
        await uploadProfilePicture(pageA, bodyA.token, makeMinimalPng(50, 50, 0, 150, 255));

        // B loads fresh (cold userDisplayNameCache) and opens the DM.
        await pageB.goto(`${BASE}/index.html`);
        await pageB.waitForSelector('.dm-item', { timeout: 10000 });
        await pageB.click('.dm-item >> nth=0');
        await expect(pageB.locator('#message-input')).toBeEnabled({ timeout: 5000 });
        await waitForWs(pageB);
        await waitForWs(pageA);

        // A sends a DM message; A reacts to it.
        await pageA.evaluate(async ({ dmChannelId, otherUserId }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            const res = await fetch('/api/identity/' + otherUserId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const data = await res.json();
            const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const enc = E2ECrypto.encryptDm(JSON.stringify({ type: 'text', text: 'hover avatar target' }), dmChannelId, kp.privateKey, otherPub);
            ws.send(JSON.stringify({
                type: 'dm_send',
                dm_channel_id: dmChannelId,
                encrypted_content: enc.ciphertext,
                nonce: enc.nonce,
                message_nonce: enc.messageNonce || null,
            }));
        }, { dmChannelId, otherUserId: bodyB.user.id });
        await pageA.waitForTimeout(600);
        const dmMsgs = await (await pageA.request.get(`${BASE}/api/dm/${dmChannelId}/messages?limit=50`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const dmMsg = (dmMsgs || []).find((m: any) => m.id);
        expect(dmMsg).toBeTruthy();
        expect(await sendDmReaction(pageA, dmChannelId, bodyB.user.id, dmMsg.id, '❤️')).toBe('sent');

        // B sees the pill.
        await pageB.waitForSelector(`.message[data-message-id="${dmMsg.id}"] .reaction-pill`, { timeout: 8000 });

        // Simulate a cold/partial cache: drop A's cached PFP fields, then wrap
        // the DM profile fetch with a delay so we can watch the card upgrade
        // from an initial circle to the real avatar on demand.
        await pageB.evaluate((uid) => {
            const c = userDisplayNameCache[uid];
            if (c) { c.profile_picture_file_id = null; c.profile_picture_file_key = null; }
        }, bodyA.user.id);
        await pageB.evaluate(() => {
            (window as any).__dmProfileFetches = [];
            const orig = (window as any).fetchDmConversationProfile;
            (window as any).fetchDmConversationProfile = async function (uid: string, cid: string) {
                (window as any).__dmProfileFetches.push([uid, cid]);
                await new Promise((r) => setTimeout(r, 700));
                return orig.call(this, uid, cid);
            };
        });

        // Hover: the card first shows the initial circle (fetch pending)...
        await pageB.hover(`.message[data-message-id="${dmMsg.id}"] .reaction-pill`);
        await pageB.waitForSelector('#msg-status-tooltip', { state: 'visible', timeout: 5000 });
        const initial = await pageB.evaluate(() => ({
            initialCircle: !!document.querySelector('#msg-status-tooltip .mst-avatar-initial'),
            img: !!document.querySelector('#msg-status-tooltip .mst-avatar-img'),
        }));
        expect(initial.initialCircle).toBe(true);
        expect(initial.img).toBe(false);

        // ...then the on-demand fetch lands and the real avatar replaces it.
        await pageB.waitForSelector('#msg-status-tooltip .mst-avatar-img', { timeout: 10000 });
        const after = await pageB.evaluate(() => {
            const img = document.querySelector('#msg-status-tooltip .mst-avatar-img') as HTMLImageElement | null;
            return {
                fetches: (window as any).__dmProfileFetches || [],
                src: img ? img.src : null,
            };
        });
        expect(after.fetches.length).toBeGreaterThan(0);
        expect(after.fetches[0][0]).toBe(bodyA.user.id);
        expect(after.fetches[0][1]).toBe(dmChannelId);
        // The avatar is a real decrypted image (blob URL served from the
        // encrypted file), not an empty src or a placeholder.
        expect(after.src).toMatch(/^blob:/);
        expect(after.src.length).toBeGreaterThan(20);

        await ctxA.close();
        await ctxB.close();
    });

    test('DM reaction toggles on/off and only the two members see the pill', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'rctd_' + Date.now();
        const uB = 'rctd2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);

        const codeB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await pageA.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: codeB },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await pageB.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
        })).json();
        await pageB.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        const dm = await (await pageA.request.post(`${BASE}/api/dm/${bodyB.user.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const dmChannelId = dm.dm_channel_id || dm.id;
        await waitForWs(pageA);
        await waitForWs(pageB);

        // A sends a DM message; B reacts to it.
        await pageA.evaluate(async ({ dmChannelId, otherUserId }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            const res = await fetch('/api/identity/' + otherUserId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const data = await res.json();
            const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const enc = E2ECrypto.encryptDm(JSON.stringify({ type: 'text', text: 'dm reaction target' }), dmChannelId, kp.privateKey, otherPub);
            ws.send(JSON.stringify({
                type: 'dm_send',
                dm_channel_id: dmChannelId,
                encrypted_content: enc.ciphertext,
                nonce: enc.nonce,
                message_nonce: enc.messageNonce || null,
            }));
        }, { dmChannelId, otherUserId: bodyB.user.id });
        await pageA.waitForTimeout(600);

        // Get the DM message id via REST.
        const dmMsgs = await (await pageA.request.get(`${BASE}/api/dm/${dmChannelId}/messages?limit=50`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const dmMsg = (dmMsgs || []).find((m: any) => m.id);
        expect(dmMsg).toBeTruthy();

        // B reacts with ❤️.
        expect(await sendDmReaction(pageB, dmChannelId, bodyA.user.id, dmMsg.id, '❤️')).toBe('sent');
        await pageA.waitForTimeout(600);

        // A's REST view of the DM shows the reaction; B can see it too.
        const dmMsgs2 = await (await pageA.request.get(`${BASE}/api/dm/${dmChannelId}/messages?limit=50`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const withReaction = (dmMsgs2 || []).find((m: any) => m.id === dmMsg.id);
        expect((withReaction.reactions || []).length).toBe(1);
        expect(withReaction.reactions[0].reactor_user_id).toBe(bodyB.user.id);

        // Toggle off by B.
        expect(await sendDmReaction(pageB, dmChannelId, bodyA.user.id, dmMsg.id, '❤️')).toBe('sent');
        await pageA.waitForTimeout(600);
        const dmMsgs3 = await (await pageA.request.get(`${BASE}/api/dm/${dmChannelId}/messages?limit=50`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const afterOff = (dmMsgs3 || []).find((m: any) => m.id === dmMsg.id);
        expect((afterOff.reactions || []).length).toBe(0);

        await ctxA.close();
        await ctxB.close();
    });

    test('non-member cannot react to a channel message', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxC = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageC = await ctxC.newPage();
        const uA = 'rctn_' + Date.now();
        const uC = 'rctn2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyC = await registerUser(pageC, uC);
        const { serverId, channelId } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await waitForWs(pageA);
        expect(await sendServerMessageViaWs(pageA, channelId, serverId, 'private react target')).toBe('sent');
        await pageA.waitForTimeout(400);
        const textMap = await pageA.evaluate(async ({ channelId, serverId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const key = E2ECrypto.getServerKey(serverId);
            const map: Record<string, string> = {};
            for (const m of msgs || []) {
                try { map[m.id] = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key); } catch (_) {}
            }
            return map;
        }, { channelId, serverId });
        const messageId = Object.keys(textMap)[0];

        // Non-member C tries to react via WS — server rejects (no membership).
        await waitForWs(pageC);
        const result = await pageC.evaluate(async ({ channelId, messageId }) => {
            const key = E2ECrypto.generateSymmetricKey();
            const payload = { e: '👍' };
            const enc = E2ECrypto.encryptMessage(JSON.stringify(payload), key);
            const token = E2ECrypto.hmacHex(key, 'reaction-v1:👍');
            ws.send(JSON.stringify({
                type: 'message_reaction',
                channel_id: channelId,
                message_id: messageId,
                emoji_token: token,
                encrypted_emoji: enc.ciphertext,
                emoji_nonce: enc.nonce,
            }));
            return 'sent';
        }, { channelId, messageId });
        await pageC.waitForTimeout(600);

        // No reaction was stored.
        const after = await getChannelMessage(pageA, channelId, serverId, messageId);
        expect((after.msg.reactions || []).length).toBe(0);

        await ctxA.close();
        await ctxC.close();
    });

    test('infinite scroll: older messages still render their reaction pills', async ({ page }) => {
        const u = 'rcts_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);

        // Send 60 messages so the first one is out of the initial PAGE_SIZE=50 window.
        for (let i = 0; i < 60; i++) {
            expect(await sendServerMessageViaWs(page, channelId, serverId, 'message number ' + i)).toBe('sent');
        }
        await page.waitForTimeout(800);
        const textMap = await page.evaluate(async ({ channelId, serverId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=200`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const key = E2ECrypto.getServerKey(serverId);
            const map: Record<string, string> = {};
            for (const m of msgs || []) {
                try { map[m.id] = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key); } catch (_) {}
            }
            return map;
        }, { channelId, serverId });
        const ids = Object.keys(textMap);
        expect(ids.length).toBe(60);
        const firstId = ids[0]; // oldest (REST returns oldest-first)
        expect(await sendChannelReaction(page, channelId, serverId, firstId, '🎉', null)).toBe('sent');
        await page.waitForTimeout(500);

        // Open the channel in the UI and scroll up to paginate into older history.
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await expect(page.locator('#message-input')).toBeEnabled({ timeout: 5000 });

        // Scroll to top repeatedly until the oldest message is rendered.
        await page.evaluate(async () => {
            const list = document.getElementById('message-list');
            for (let i = 0; i < 10; i++) {
                if (list) list.scrollTop = 0;
                await new Promise((r) => setTimeout(r, 300));
            }
        });
        await page.waitForSelector(`.message[data-message-id="${firstId}"]`, { timeout: 15000 });
        await page.waitForSelector(`.message[data-message-id="${firstId}"] .reaction-pill`, { timeout: 8000 });
        const pill = await page.evaluate((id) => {
            const pillEl = document.querySelector(`.message[data-message-id="${id}"] .reaction-pill`);
            return pillEl ? {
                count: parseInt(pillEl.getAttribute('data-count') || '0', 10),
                mine: pillEl.classList.contains('mine'),
            } : null;
        }, firstId);
        expect(pill).toEqual({ count: 1, mine: true });
    });

    test('reactions are blind: wrong-key decryption yields nothing; tokens are HMACs', async ({ page }) => {
        const u = 'rctb_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);
        expect(await sendServerMessageViaWs(page, channelId, serverId, 'blindness target')).toBe('sent');
        await page.waitForTimeout(400);
        const textMap = await page.evaluate(async ({ channelId, serverId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const key = E2ECrypto.getServerKey(serverId);
            const map: Record<string, string> = {};
            for (const m of msgs || []) {
                try { map[m.id] = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key); } catch (_) {}
            }
            return map;
        }, { channelId, serverId });
        const messageId = Object.keys(textMap)[0];
        expect(await sendChannelReaction(page, channelId, serverId, messageId, '😮', null)).toBe('sent');
        await page.waitForTimeout(500);

        // A client WITHOUT the channel key cannot decrypt the reaction payload.
        const wrongKeyResult = await page.evaluate(async ({ channelId, messageId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const m = (msgs || []).find((x: any) => x.id === messageId);
            const wrongKey = E2ECrypto.generateSymmetricKey();
            let dec = null;
            try {
                dec = E2ECrypto.decryptMessage(m.reactions[0].encrypted_emoji, m.reactions[0].emoji_nonce, wrongKey);
            } catch (_) {}
            return dec;
        }, { channelId, messageId });
        expect(wrongKeyResult).toBeNull();

        // With the real key it decrypts to the expected payload.
        const rightKeyResult = await page.evaluate(async ({ channelId, serverId, messageId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const m = (msgs || []).find((x: any) => x.id === messageId);
            const key = E2ECrypto.getServerKey(serverId);
            return JSON.parse(E2ECrypto.decryptMessage(m.reactions[0].encrypted_emoji, m.reactions[0].emoji_nonce, key) || 'null');
        }, { channelId, serverId, messageId });
        expect(rightKeyResult.e).toBe('😮');
    });
});
